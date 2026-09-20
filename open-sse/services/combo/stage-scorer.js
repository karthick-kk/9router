/**
 * Trajectory scorer for the composite-stage strategy.
 *
 * Looks at the recent agent trajectory (tool calls the assistant made and the
 * results that came back) and produces a normalized 0..1 "capable score": how much
 * the evidence says the next turn needs the capable model.
 *
 * Four signals, weighted and clamped:
 *   error severity        — commands/tests/compilers failing
 *   spinning              — the same command or the same error coming back again
 *   exploration           — reading and searching rather than writing
 *   production intensity  — actively editing files (the one signal that pulls
 *                           *toward* the efficient tier)
 *
 * The weights are plain constants so behavior is inspectable and tunable, and every
 * signal is derived from text that is already in the request — no extra model calls.
 */

import {
  conversationItems,
  isAssistantItem,
  toolCallNames,
  toolResultEntries,
} from "./trajectory.js";

export const STAGE_DEFAULTS = {
  enabled: true,
  criticalErrorOverride: true,
  // How many trailing assistant/tool turn pairs to consider. Small on purpose: the
  // question is "what is happening now", not "what happened at the start".
  windowTurns: 6,
  weights: {
    errorSeverity: 0.40,
    spinning: 0.30,
    exploration: 0.25,
    productionIntensity: 0.35,
  },
};

// Tool-name fragments, matched case-insensitively against the tool names the
// assistant actually called. Deliberately generic so this works across agent
// harnesses (Claude Code, Cline, Cursor, …) without a per-client table.
const EXPLORATION_TOOL_HINTS = ["read", "grep", "search", "glob", "find", "list", "ls", "cat", "view", "fetch", "lookup", "tree", "explore", "inspect"];
// `bash` matters most: running commands is the workhorse of an agentic session, and
// leaving it uncategorized made every shell-driven turn score as if nothing happened.
const PRODUCTION_TOOL_HINTS = ["bash", "edit", "write", "create", "apply", "patch", "diff", "replace", "insert", "append", "update", "delete", "move", "rename", "format", "run", "execute", "install"];

// Error evidence in tool output. `critical` patterns are the ones where continuing
// on the efficient model is most likely to waste a turn.
const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bfailed\b/i,
  /\bfailure\b/i,
  /\bexception\b/i,
  /\btraceback\b/i,
  /\bstack ?trace\b/i,
  /\bassertion\b/i,
  /\bnot found\b/i,
  /\bcannot find\b/i,
  /\bundefined (?:is not|reference)\b/i,
  /\bpermission denied\b/i,
  /\btimed? ?out\b/i,
  /\btests? failed\b/i,
  /\b\d+ (?:failing|failed)\b/i,
  /\bexit(?: code|status)? [1-9]\d*\b/i,
  /\bnon-?zero exit\b/i,
  /\bcompil(?:e|ation) (?:error|failed)\b/i,
  /\bsyntaxerror\b/i,
  /\btypeerror\b/i,
  /\bsegmentation fault\b/i,
  /\bpanic:/i,
];

const CRITICAL_ERROR_PATTERNS = [
  /\bsegmentation fault\b/i,
  /\bpanic:/i,
  /\bfatal\b/i,
  /\bcritical\b/i,
  /\bcompil(?:e|ation) (?:error|failed)\b/i,
  /\bcannot find module\b/i,
  /\bout of memory\b/i,
  /\bdata loss\b/i,
  /\bcorrupt(?:ed|ion)?\b/i,
  /\bdeadlock\b/i,
];

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function matchesAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

function hasHint(name, hints) {
  const lower = name.toLowerCase();
  return hints.some((h) => lower.includes(h));
}

// Normalize tool output for repeat detection: collapse whitespace, strip digits,
// hex and quoted paths so "3 tests failed in 1.2s" and "3 tests failed in 0.9s"
// compare equal. Truncated so one huge file dump can't dominate the hash.
function errorSignature(text) {
  return text
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "#")
    .replace(/\b[0-9a-f]{8,}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/**
 * Pull the recent trajectory out of a request body.
 * @param {object} body
 * @param {number} windowTurns
 * @returns {{ toolNames: string[], results: {text: string, isError: boolean}[] }}
 */
function collectTrajectory(body, windowTurns) {
  const { items } = conversationItems(body);
  if (items.length === 0) return { toolNames: [], results: [] };

  // Walk back to the start of the window, counting assistant turns as boundaries.
  let start = items.length;
  let assistantTurns = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    start = i;
    if (isAssistantItem(items[i])) {
      assistantTurns++;
      if (assistantTurns >= windowTurns) break;
    }
  }

  const toolNames = [];
  const results = [];
  for (let i = start; i < items.length; i++) {
    const item = items[i];
    for (const name of toolCallNames(item)) toolNames.push(name);
    for (const entry of toolResultEntries(item)) {
      if (entry.text) results.push(entry);
    }
  }
  return { toolNames, results };
}

/**
 * Compute the four signals plus the combined capable score for a request.
 *
 * @param {object} opts
 * @param {object} opts.body - Request body in client format.
 * @param {object} [opts.cfg] - Overrides for STAGE_DEFAULTS.
 * @returns {{ score: number, criticalError: boolean, hasEvidence: boolean, signals: object }}
 */
export function scoreStage({ body, cfg = {} }) {
  const conf = { ...STAGE_DEFAULTS, ...cfg, weights: { ...STAGE_DEFAULTS.weights, ...(cfg.weights || {}) } };
  const { toolNames, results } = collectTrajectory(body, conf.windowTurns);

  const empty = {
    score: 0,
    criticalError: false,
    hasEvidence: false,
    signals: { errorSeverity: 0, spinning: 0, exploration: 0, productionIntensity: 0 },
  };
  if (toolNames.length === 0 && results.length === 0) return empty;

  // --- 1. Error severity: share of recent tool results that came back bad. ---
  let errored = 0;
  let criticalError = false;
  const signatures = [];
  for (const entry of results) {
    const isError = entry.isError || matchesAny(entry.text, ERROR_PATTERNS);
    if (!isError) continue;
    errored++;
    signatures.push(errorSignature(entry.text));
    if (conf.criticalErrorOverride && matchesAny(entry.text, CRITICAL_ERROR_PATTERNS)) criticalError = true;
  }
  const errorSeverity = results.length > 0 ? clamp01(errored / results.length) : 0;

  // --- 2. Spinning: the same failure, or the same command, coming back again. ---
  const repeatedErrors = countRepeats(signatures);
  const repeatedCommands = countRepeats(toolNames.map((n) => n.toLowerCase()));
  // Repeated errors are far stronger evidence of being stuck than a repeated tool
  // name (agents legitimately call Read many times), so they dominate the signal.
  const spinning = clamp01(repeatedErrors * 0.5 + Math.min(repeatedCommands, 4) * 0.1);

  // --- 3/4. Exploration vs production, from what the assistant chose to call. ---
  let exploring = 0;
  let producing = 0;
  for (const name of toolNames) {
    if (hasHint(name, PRODUCTION_TOOL_HINTS)) producing++;
    else if (hasHint(name, EXPLORATION_TOOL_HINTS)) exploring++;
  }
  const classified = exploring + producing;
  const exploration = classified > 0 ? clamp01(exploring / classified) : 0;
  // Production only counts as efficiency evidence to the extent the work is landing:
  // credit is scaled down in proportion to the error rate, reaching zero when every
  // recent result failed. Editing and running commands while tests fail is a struggle,
  // not routine production. Without this scaling a spinning agent scores as
  // "productive" and gets sent to the cheap model exactly when it needs the capable one.
  const rawProduction = classified > 0 ? clamp01(producing / classified) : 0;
  const productionIntensity = clamp01(rawProduction * (1 - errorSeverity));

  const w = conf.weights;
  const score = clamp01(
    errorSeverity * w.errorSeverity +
    spinning * w.spinning +
    exploration * w.exploration -
    productionIntensity * w.productionIntensity
  );

  return {
    score,
    criticalError,
    hasEvidence: true,
    signals: {
      errorSeverity: round2(errorSeverity),
      spinning: round2(spinning),
      exploration: round2(exploration),
      productionIntensity: round2(productionIntensity),
    },
  };
}

// Number of entries beyond the first occurrence of each repeated value.
function countRepeats(values) {
  const seen = new Map();
  let repeats = 0;
  for (const v of values) {
    if (!v) continue;
    const n = (seen.get(v) || 0) + 1;
    seen.set(v, n);
    if (n > 1) repeats++;
  }
  return repeats;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
