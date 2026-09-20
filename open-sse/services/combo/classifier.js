/**
 * LLM tier classifier for the composite-stage strategy.
 *
 * Runs on a new user turn only and answers one question: should this task start on
 * the capable model or the efficient one? It never solves the task, and it never
 * fails the request — any timeout, transport error, or unparseable answer resolves
 * to the capable tier, because this is a quality-first configuration.
 */

import { TIER } from "./session-state.js";
import { ROLE } from "../../translator/schema/roles.js";

export const CLASSIFIER_DEFAULTS = {
  enabled: true,
  timeoutMs: 10000,
  maxUserChars: 6000,
  maxTokens: 64,
};

// Kept deterministic and short: the classifier judges intent, so temperature 0 and
// a tight token budget both cut latency and stop it from drifting into answering.
const CLASSIFIER_SYSTEM_PROMPT = [
  "You are a routing classifier for an agentic software-engineering assistant.",
  "",
  "Choose CAPABLE when the user's new request requires:",
  "- architecture or system design decisions",
  "- comparing competing design approaches",
  "- ambiguous or underspecified requirements",
  "- deep debugging or root-cause analysis",
  "- security-sensitive decisions",
  "- concurrency/distributed-systems reasoning",
  "- unfamiliar or large-codebase analysis",
  "- major refactoring strategy",
  "- difficult reasoning where a wrong decision could be expensive",
  "",
  "Choose EFFICIENT when the request is primarily:",
  "- implementing an already-decided design",
  "- straightforward code changes",
  "- mechanical refactoring",
  "- adding conventional tests",
  "- formatting or cleanup",
  "- simple bug fixes with an obvious cause",
  "- repetitive implementation following an established pattern",
  "",
  "Classify the user's intent. Do not attempt to solve the task.",
  "Return ONLY JSON of the form {\"tier\":\"CAPABLE\",\"confidence\":0.0} or {\"tier\":\"EFFICIENT\",\"confidence\":0.0}.",
].join("\n");

const TIER_RE = /"tier"\s*:\s*"?(capable|efficient)"?/i;
const CONFIDENCE_RE = /"confidence"\s*:\s*([0-9]*\.?[0-9]+)/;

/**
 * Parse the classifier's answer. Tolerates prose or code fences around the JSON
 * because small models wrap output despite instructions; returns null when no tier
 * can be recovered, which the caller treats as a capable-tier fallback.
 *
 * @param {string} text
 * @returns {{ tier: string, confidence: number }|null}
 */
export function parseClassifierOutput(text) {
  if (typeof text !== "string" || !text.trim()) return null;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const tier = normalizeTier(parsed?.tier);
      if (tier) return { tier, confidence: normalizeConfidence(parsed?.confidence) };
    } catch {
      // Fall through to the regex path below.
    }
  }

  const tierMatch = text.match(TIER_RE);
  if (!tierMatch) return null;
  const tier = normalizeTier(tierMatch[1]);
  if (!tier) return null;
  const confMatch = text.match(CONFIDENCE_RE);
  return { tier, confidence: normalizeConfidence(confMatch ? Number(confMatch[1]) : undefined) };
}

function normalizeTier(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === TIER.CAPABLE) return TIER.CAPABLE;
  if (v === TIER.EFFICIENT) return TIER.EFFICIENT;
  return null;
}

// An absent/garbage confidence must not read as "certain": 0 keeps capable-first
// from downgrading on a classifier that only returned a tier.
function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return n <= 100 ? n / 100 : 1;
  return n;
}

/**
 * Build the classifier request body. Deliberately minimal — no tools, no streaming,
 * no history — so the classifier call stays cheap and can't emit tool_calls.
 *
 * The instructions ride in the *user* turn rather than a system message. A system
 * message is not universally portable: the `claude:kiro` direct route reads its
 * system prompt from the top-level `system` field only, so a `role:"system"` entry
 * is dropped outright and the classifier would silently receive no instructions and
 * try to answer the task instead. Every format carries user text, so this survives
 * translation to all of them.
 *
 * @param {string} userText
 * @param {object} [cfg]
 */
export function buildClassifierBody(userText, cfg = {}) {
  const maxChars = cfg.maxUserChars || CLASSIFIER_DEFAULTS.maxUserChars;
  const truncated = userText.length > maxChars ? `${userText.slice(0, maxChars)}\n…[truncated]` : userText;
  return {
    // Set for the formats that do read a top-level system prompt; the user turn
    // below repeats it so nothing depends on that field surviving.
    system: CLASSIFIER_SYSTEM_PROMPT,
    messages: [
      { role: ROLE.USER, content: `${CLASSIFIER_SYSTEM_PROMPT}\n\n=== NEW USER REQUEST ===\n${truncated}\n=== END NEW USER REQUEST ===\n\nRespond with only the JSON.` },
    ],
    stream: false,
    temperature: 0,
    max_tokens: cfg.maxTokens || CLASSIFIER_DEFAULTS.maxTokens,
  };
}

// Extract assistant text from a completion in any client format. Kept local (rather
// than reusing combo.js's extractPanelText) because the classifier body is always
// OpenAI-chat shaped, but the *response* comes back in the client's format.
function extractText(json) {
  if (!json || typeof json !== "object") return "";
  const choice = json.choices?.[0];
  const fromChoice = choice?.message?.content ?? choice?.delta?.content ?? choice?.text;
  if (typeof fromChoice === "string" && fromChoice.trim()) return fromChoice;
  if (Array.isArray(fromChoice)) {
    const t = fromChoice.map((c) => c?.text || "").join("");
    if (t.trim()) return t;
  }
  if (Array.isArray(json.content)) {
    const t = json.content.map((c) => c?.text || "").join("");
    if (t.trim()) return t;
  }
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }
  return "";
}

/**
 * Classify a new user turn.
 *
 * @param {object} opts
 * @param {string} opts.userText - Text of the new user turn.
 * @param {string} opts.classifierModel - `provider/model` to classify with.
 * @param {Function} opts.handleSingleModel - (body, modelStr, isPanel) => Promise<Response>
 * @param {object} [opts.cfg] - Overrides for CLASSIFIER_DEFAULTS.
 * @returns {Promise<{ tier: string, confidence: number, reason: string }>} Never rejects.
 */
export async function classifyTier({ userText, classifierModel, handleSingleModel, cfg = {} }) {
  const timeoutMs = cfg.timeoutMs || CLASSIFIER_DEFAULTS.timeoutMs;
  const fallback = (reason) => ({ tier: TIER.CAPABLE, confidence: 0, reason });

  if (!classifierModel || !userText) return fallback("classifier not configured");

  const body = buildClassifierBody(userText, cfg);

  let timer = null;
  try {
    const call = Promise.resolve(handleSingleModel(body, classifierModel, true));
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
    });
    const res = await Promise.race([call, timeout]);

    if (res?.__timeout) return fallback("classifier timeout");
    if (!res?.ok) return fallback(`classifier http ${res?.status ?? "error"}`);

    const json = await res.clone().json();
    const parsed = parseClassifierOutput(extractText(json));
    if (!parsed) return fallback("classifier output unparseable");
    return { ...parsed, reason: "classified" };
  } catch (error) {
    return fallback(`classifier error: ${error?.message || String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
