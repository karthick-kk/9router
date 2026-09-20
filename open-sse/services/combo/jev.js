/**
 * Jev classifier strategy for combos (TypeSafe System One).
 *
 * Asks Jev one `choice` question — which combo model should serve this
 * request — and moves the winner to the front of the model list. The normal
 * combo fallback loop then serves it exactly like the "fallback" strategy,
 * so a wrong pick is still caught by the existing retry chain.
 *
 * Fail-open like every rtk/sidecar hook: any timeout, HTTP error, unparseable
 * or out-of-catalog answer, or low confidence returns null and the caller
 * keeps the original order. Jev's answer never breaks a request.
 */

import { getCapabilitiesForModel } from "../../providers/capabilities.js";

export const JEV_DEFAULTS = {
  url: "https://api.typesafe.ai/v1/systemone",
  model: "jev-latest",
  timeoutMs: 3000,
  confidenceGate: 0.5,
  maxUserChars: 6000,
};

// Per-combo routing preference. "efficient" = cheapest model that covers the
// task (default); "quality" = strongest model unless the task is trivial.
export const JEV_MODES = {
  efficient: "Prefer the cheapest model whose described strengths cover the task; use a stronger model only when the task clearly needs it.",
  balanced: "Pick the model best suited to the task, weighing output quality and cost equally.",
  quality: "Prefer the model that produces the best output for this task; use a cheaper model only when the task is clearly trivial.",
};

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // OpenAI/Claude/Gemini block shapes; tool_result blocks carry tool output,
  // which is usually noise for routing — skip them.
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

// Pull the newest user turn + whether this call is a tool-step continuation.
// Handles OpenAI chat, Claude messages, Gemini contents and Responses `input`.
export function extractTurn(body) {
  const items = Array.isArray(body?.messages) ? body.messages
    : Array.isArray(body?.input) ? body.input
    : Array.isArray(body?.contents)
      ? body.contents.map((c) => ({ role: c.role, content: textOf(c.parts) }))
      : [];

  let lastRole = "";
  for (let i = items.length - 1; i >= 0; i--) {
    const role = items[i]?.role;
    if (role === "user" || role === "assistant") { lastRole = role; break; }
  }
  const continuation = lastRole !== "user";

  let userText = "";
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.role !== "user") continue;
    // Responses API items: user message vs function_call_output
    if (it.type === "function_call_output" || it.type === "tool_result") continue;
    userText = textOf(it.content ?? it.text);
    if (userText.trim()) break;
  }
  return { userText: userText.slice(0, JEV_DEFAULTS.maxUserChars), continuation };
}

function autoRubric(modelStr) {
  const slash = modelStr.indexOf("/");
  const provider = slash > 0 ? modelStr.slice(0, slash) : "";
  const model = slash > 0 ? modelStr.slice(slash + 1) : modelStr;
  const caps = getCapabilitiesForModel(provider, model);
  const bits = [];
  if (caps.contextWindow) bits.push(`context ${Math.round(caps.contextWindow / 1000)}k`);
  if (caps.vision) bits.push("vision");
  if (caps.tools) bits.push("tool calling");
  if (caps.reasoning) bits.push("reasoning");
  return bits.length ? `${model} (${bits.join(", ")})` : model;
}

/**
 * Order combo models with Jev's pick first.
 * @returns {Promise<string[]|null>} reordered models, or null to keep current order.
 */
export async function orderModelsByJev({ body, models, rubrics = {}, cfg = {}, log }) {
  const apiKey = cfg.apiKey || process.env.TYPESAFE_API_KEY || "";
  if (!apiKey || !Array.isArray(models) || models.length < 2) return null;

  const { userText, continuation } = extractTurn(body);
  if (!userText.trim()) return null;

  const url = cfg.url || JEV_DEFAULTS.url;
  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : JEV_DEFAULTS.timeoutMs;
  const gate = Number.isFinite(cfg.confidenceGate) ? cfg.confidenceGate : JEV_DEFAULTS.confidenceGate;

  const criteria = {};
  for (const m of models) criteria[m] = rubrics[m]?.trim() || autoRubric(m);
  const modePolicy = JEV_MODES[cfg.mode] || JEV_MODES.efficient;

  const state = {
    kind: continuation ? "tool-step continuation in an ongoing agent session" : "fresh user turn",
    userRequest: userText,
  };
  const request = {
    model: cfg.model || JEV_DEFAULTS.model,
    state,
    questions: {
      route: {
        type: "choice",
        instructions:
          "Which of these models should serve this request? Judge the request in `userRequest`; " +
          "when `kind` is a tool-step continuation, route the NEXT step, not the session's first prompt. " +
          modePolicy,
        criteria,
      },
    },
  };

  let answer;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log?.warn?.("JEV", `Classifier HTTP ${res.status}, keeping combo order`);
      return null;
    }
    answer = (await res.json())?.answers?.route;
  } catch (err) {
    log?.warn?.("JEV", `Classifier failed (${err?.name === "TimeoutError" ? "timeout" : err?.message || "error"}), keeping combo order`);
    return null;
  }

  if (answer?.type !== "choice" || !models.includes(answer.choice)) {
    log?.warn?.("JEV", "Classifier returned no usable choice, keeping combo order");
    return null;
  }
  const confidence = typeof answer.confidence === "number" ? answer.confidence : 1;
  if (confidence < gate) {
    // "rank": serve in Jev's full probability order — an uncertain pick degrades
    // through the alternatives Jev itself preferred instead of the static combo order.
    if (cfg.lowConfidence === "rank" && answer.probabilities) {
      const ranked = [...models].sort((a, b) => (answer.probabilities[b] || 0) - (answer.probabilities[a] || 0));
      log?.info?.("JEV", `Low confidence ${confidence.toFixed(2)}, following Jev ranking: ${ranked.join(" > ")}`);
      return ranked;
    }
    log?.info?.("JEV", `Low confidence ${confidence.toFixed(2)} for ${answer.choice}, keeping combo order`);
    return null;
  }

  log?.info?.("JEV", `Picked ${answer.choice} (conf ${confidence.toFixed(2)})`);
  return [answer.choice, ...models.filter((m) => m !== answer.choice)];
}
