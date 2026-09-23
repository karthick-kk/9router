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
import { getAdaptiveStats } from "./adaptive-state.js";
import { expectedReliability, latencyScore, rateLimitFactor } from "./adaptive-scoring.js";

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

// ── Live health veto ─────────────────────────────────────────────────────────
//
// The classifier ranks by task fit, not liveness — it cannot tell a
// paper-fast model that is timing out right now. The shared model-health cache
// (fed by the combo failover loop for EVERY strategy) can. This is a
// deterministic "is it clearly sick" filter applied after Jev's pick: a model
// whose live factor — reliability × speed × the 429 guardrail, the same axes
// adaptive routing blends — falls below the veto is moved to the end of the
// serve order, and a vetoed pick is replaced by the first non-vetoed model in
// combo order. Two healthy models are never reordered against each other, and
// when every model is sick the pre-veto order is kept — the failover loop is
// the unchanged backstop.

const HEALTH_VETO_THRESHOLD = 0.4;

function healthFactorFor(model, now) {
  const s = getAdaptiveStats(model, now);
  // Speed axis may only demote (≤1): a fast model earns no bonus, a slow one
  // is dinged. Unknown latency hits the optimistic prior and clamps to neutral.
  const speed = Math.max(0, Math.min(1, 1 + latencyScore(s.avgLatencyMs) - 0.5));
  return expectedReliability(s.successes, s.failures) * speed * rateLimitFactor(s.penalty);
}

/** Sick models (factor < veto) moved to the tail; healthy ones keep their relative order. */
function demoteSick(models, now) {
  const sick = models.filter((m) => healthFactorFor(m, now) < HEALTH_VETO_THRESHOLD);
  if (sick.length === 0 || sick.length === models.length) return { order: models, sick };
  const sickSet = new Set(sick);
  return { order: [...models.filter((m) => !sickSet.has(m)), ...sick], sick };
}

/**
 * Order combo models with Jev's pick first.
 *
 * Every decision and fail-open is reported through `onDecision(rec)` (exactly
 * once per call) so the caller can persist a routingDecisions row; the strategy
 * itself stays DB-free. A throwing `onDecision` never breaks routing.
 *
 * @returns {Promise<string[]|null>} reordered models, or null to keep current order.
 */
export async function orderModelsByJev({ body, models, rubrics = {}, cfg = {}, log, comboName = null, sessionId = null, turn = 1, onDecision }) {
  const emit = (rec) => {
    if (typeof onDecision !== "function") return;
    try { onDecision({ combo: comboName, strategy: "jev", sessionId, turn, ...rec }); }
    catch { /* capture must never break routing */ }
  };
  const apiKey = cfg.apiKey || process.env.TYPESAFE_API_KEY || "";
  if (!apiKey) {
    emit({ source: "jev", reason: "no-api-key", picked: Array.isArray(models) ? models[0] : null, confidence: null, scores: {}, preview: "", classifierMs: null });
    return null;
  }
  if (!Array.isArray(models) || models.length < 2) {
    emit({ source: "jev", reason: "single-model", picked: models?.[0] || null, confidence: null, scores: {}, preview: "", classifierMs: null });
    return null;
  }

  const { userText, continuation } = extractTurn(body);
  const preview = userText.slice(0, 200);
  if (!userText.trim()) {
    emit({ source: "jev", reason: "no-user-text", picked: models[0], confidence: null, scores: {}, preview, classifierMs: null });
    return null;
  }

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

  const t0 = Date.now();
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
      emit({ source: "jev", reason: `http-${res.status}`, picked: models[0], confidence: null, scores: {}, preview, classifierMs: Date.now() - t0 });
      return null;
    }
    answer = (await res.json())?.answers?.route;
  } catch (err) {
    log?.warn?.("JEV", `Classifier failed (${err?.name === "TimeoutError" ? "timeout" : err?.message || "error"}), keeping combo order`);
    emit({ source: "jev", reason: err?.name === "TimeoutError" ? "timeout" : "error", picked: models[0], confidence: null, scores: {}, preview, classifierMs: Date.now() - t0 });
    return null;
  }
  const elapsed = Date.now() - t0;
  const probabilities = answer?.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : {};

  if (answer?.type !== "choice" || !models.includes(answer.choice)) {
    log?.warn?.("JEV", "Classifier returned no usable choice, keeping combo order");
    emit({ source: "jev", reason: "no-usable-choice", picked: models[0], confidence: null, scores: { probabilities }, preview, classifierMs: elapsed });
    return null;
  }
  const confidence = typeof answer.confidence === "number" ? answer.confidence : 1;
  if (confidence < gate) {
    // "rank": serve in Jev's full probability order — an uncertain pick degrades
    // through the alternatives Jev itself preferred instead of the static combo order.
    if (cfg.lowConfidence === "rank" && Object.keys(probabilities).length > 0) {
      const now = Date.now();
      // Vetoed models sink to the end (sentinel -1); the rest keep Jev's
      // probability order, ties broken by combo order (stable sort).
      const ranked = [...models]
        .map((m) => ({ m, p: healthFactorFor(m, now) < HEALTH_VETO_THRESHOLD ? -1 : probabilities[m] || 0 }))
        .sort((a, b) => b.p - a.p)
        .map((e) => e.m);
      log?.info?.("JEV", `Low confidence ${confidence.toFixed(2)}, following Jev ranking: ${ranked.join(" > ")}`);
      emit({ source: "jev", reason: "ranked", picked: ranked[0], confidence, scores: { probabilities }, preview, classifierMs: elapsed });
      return ranked;
    }
    log?.info?.("JEV", `Low confidence ${confidence.toFixed(2)} for ${answer.choice}, keeping combo order`);
    emit({ source: "jev", reason: "below-gate-held", picked: models[0], confidence, scores: { probabilities }, preview, classifierMs: elapsed });
    return null;
  }

  // Health veto: Jev picks by task fit and cannot see that its pick is timing
  // out or failing right now. When the pick's live health factor is clearly
  // sick, serve the configured order with ALL sick models demoted to the end —
  // healthy models keep their relative order, and if every model is sick the
  // pre-veto order is returned unchanged (failover loop is the backstop).
  const pickFactor = healthFactorFor(answer.choice, Date.now());
  if (pickFactor < HEALTH_VETO_THRESHOLD) {
    const { order, sick } = demoteSick(models, Date.now());
    log?.info?.("JEV", `Vetoed ${answer.choice} (health ${pickFactor.toFixed(2)} < ${HEALTH_VETO_THRESHOLD}, sick: ${sick.join(", ")}), keeping combo order`);
    emit({ source: "jev", reason: "health-veto", picked: order[0], confidence, scores: { probabilities, veto: { picked: answer.choice, factor: pickFactor, sick } }, preview, classifierMs: elapsed });
    return order;
  }
  log?.info?.("JEV", `Picked ${answer.choice} (conf ${confidence.toFixed(2)})`);
  emit({ source: "jev", reason: "classified", picked: answer.choice, confidence, scores: { probabilities }, preview, classifierMs: elapsed });
  return [answer.choice, ...models.filter((m) => m !== answer.choice)];
}
