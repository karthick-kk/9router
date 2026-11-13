/**
 * "sentryforge" combo strategy — a code-aware guard over the CLEF classifier.
 *
 * Routes each request between two pools of combo members:
 *   - **Kiro models**   (`kr/…`, `krb/…`)  — billable, agentic executable-file writes.
 *   - **Acme models** (`acme/…`, any non-Kiro member) — free (local
 *     datacenter), and therefore the preferred target for everything that does
 *     NOT mutate executable project files in git. The one hard rule this
 *     strategy exists to enforce is: a turn that asks the agent to create,
 *     modify, fix, or refactor executable project files (source, config-as-code,
 *     build scripts, SQL migrations, shell tooling) never reaches an Acme model.
 *
 * Acme MAY return prose that contains illustrative code snippets, pseudocode,
 * interface sketches, or policy examples inside a spec sheet, design doc, or
 * explanation — that is not agentic coding. Writing a markdown/doc file is also
 * not gated, because the primary work is prose synthesis. "Mutates executable
 * project files in git" is the boundary, not "contains code tokens".
 *
 * Decision flow:
 *   1. Split `models` into the two pools by provider prefix (Kiro vs the rest).
 *      The split is deterministic and never delegated to the classifier.
 *   2. Ask CLEF one request, two `choice` questions:
 *        - `kind`  — does this turn require an agentic mutation of executable
 *                    project files in git?  { code | noncode }
 *        - `route` — which candidate member should serve it?
 *      A single round-trip to the existing /v1/systemone endpoint (the same
 *      `Cloudflare/clef` decision model the CreditWise proxy uses).
 *   3. Apply the guard:
 *        - kind == code    → serve the best **Kiro** member. The returned list
 *                            is Kiro-only, so the failover loop can NEVER fall
 *                            through to an Acme model on this turn.
 *        - kind == noncode → serve the best **Acme** member (Kiro models kept
 *                            as the tail of the serve order). The answer may
 *                            contain example snippets — that is explicitly allowed.
 *        - any failure, timeout, missing kind, or a "noncode" label whose
 *          confidence is below the gate → **Kiro-only**, for the same reason.
 *
 *   Fail-closed on the forbidden side: routing a non-code turn to Kiro costs a
 *   few credits; routing an executable-file mutation to Acme breaks the invariant.
 *   Every mechanical miss therefore resolves to Kiro. The only path that reaches
 *   Acme is a CLEF decision that (a) classifies the turn "noncode" with
 *   confidence at/above the gate and (b) names an Acme model as the pick —
 *   an accepted classifier judgement, identical to how every other classifier
 *   strategy trusts a pick.
 */

import { getCapabilitiesForModel } from "../../providers/capabilities.js";
import { extractTurn, parseDecisionBody, demoteSick } from "./jev.js";

// CLEF runs behind the acme-proxy (127.0.0.1:7999); the proxy injects upstream
// credentials, so this placeholder only satisfies the fail-open guard and never
// represents a real secret (mirrors classifierCfg's `clef-local`).
const SENTRY_DEFAULTS = {
  url: "http://127.0.0.1:7999/v1/systemone",
  model: "Cloudflare/clef",
  apiKey: "clef-local",
  timeoutMs: 3000,
  // Minimum CLEF confidence required to trust a "noncode" label enough to route
  // to Acme. Below this, the turn is served by Kiro. (A "code" label routes to
  // Kiro at ANY confidence — that direction is always safe.)
  codeConfidenceGate: 0.85,
};

// Kiro provider prefixes. Any member NOT in this set is treated as Acme (the
// free local pool) — including future custom nodes — which keeps the split robust
// without per-combo configuration.
const KIRO_PREFIXES = new Set(["kr", "krb", "kiro", "kiro-cli"]);

function providerPrefix(model) {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "";
}

export function isKiroModel(model) {
  return KIRO_PREFIXES.has(providerPrefix(model));
}

// Which members can actually serve this turn (vision/audio/… present). Kept
// deliberately minimal — the capacity adapter already handles this downstream,
// and we only need to avoid routing code to a model that would immediately fail.
function serviceable(models, requiredCapabilities = null) {
  if (!requiredCapabilities || requiredCapabilities.size === 0) return models;
  const hard = [...requiredCapabilities].filter((c) =>
    ["vision", "pdf", "audioInput", "videoInput"].includes(c)
  );
  if (hard.length === 0) return models;
  return models.filter((m) => {
    const slash = m.indexOf("/");
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    return hard.every((c) => caps[c] === true);
  });
}

// Reuse jev's live health veto: sick members (reliability × speed × 429 guardrail
// below the veto threshold) sink to the tail. Handles the (theoretical) non-slashed
// member by appending it verbatim after the slashed pool.
function dehealth(models, now) {
  const slashed = models.filter((m) => m.includes("/"));
  return [...demoteSick(slashed, now).order, ...models.filter((m) => !m.includes("/"))];
}

/**
 * Prompt CLEF for the executable-file-write / non-write kind. Policy is SOLELY
 * about whether the user is asking the agent to mutate executable project files
 * in git — not about whether the answer happens to contain code text.
 *
 * noncode (Acme-eligible) explicitly includes tasks whose answer contains
 * illustrative code snippets (inside prose OR inside a markdown/doc file):
 * spec sheets, design docs, planning, research, summarization, brainstorming,
 * emails, documents, maths or analysis, and explanations of code. A markdown
 * spec that shows example code is still noncode — it is a prose document, not
 * an executable-file mutation. The guard is executable-file writes, not code tokens.
 */
function classificationKind() {
  return [
    "Classify ONLY whether the turn asks the agent to do agentic coding that writes or mutates files in git.",
    "Say `code` ONLY when the request asks the agent to create, modify, fix, refactor, debug, or test executable project files — source, config-as-code, build scripts, SQL migrations, or shell tooling — via tools, patches, or diffs that change tracked files and affect repo behaviour. This is the ONLY trigger for `code`.",
    "Say `noncode` for everything else, INCLUDING (a) conversational answers that contain illustrative code snippets, pseudocode, interface sketches, SQL/shell examples inside prose, and (b) spec sheets, design docs, markdown documents (e.g. src/rate-limit-design.md), planning, research, summarization, brainstorming, emails, maths or data analysis, and explanations of how existing code works — even when the deliverable is written to a markdown/doc file, because the primary work is prose synthesis, not executable code. A spec sheet that shows example code is still `noncode`.",
    "Code snippets inside prose — whether in a chat answer or inside a markdown/design doc — do NOT make the task `code`. Only agentic creation or mutation of executable project files does.",
    "Guard: agentic coding that mutates executable project files in git must NEVER go to Acme, so err toward `code` ONLY when the turn actually asks to create or change such files. Do not use `code` as a precaution for snippets or for prose/markdown file writes.",
  ].join(" ");
}

/**
 * Order combo models for the sentryforge strategy.
 *
 * @returns {Promise<string[]|null>} reordered serve order, or null to keep combo order.
 */
export async function orderModelsBySentryforge({
  body,
  models,
  cfg = {},
  log,
  comboName = null,
  sessionId = null,
  turn = 1,
  requiredCapabilities = null,
  onDecision,
}) {
  const emit = (rec) => {
    if (typeof onDecision !== "function") return;
    try {
      onDecision({ combo: comboName, strategy: "sentryforge", source: "sentryforge", sessionId, turn, ...rec });
    } catch {
      /* capture must never break routing */
    }
  };

  if (!Array.isArray(models) || models.length < 2) {
    emit({ reason: "single-model", picked: models?.[0] || null, confidence: null, scores: {}, preview: "", classifierMs: null });
    return null;
  }

  const kiro = models.filter(isKiroModel);
  const eric = models.filter((m) => !isKiroModel(m));

  // No Acme members → there is nothing to save; serve in combo order.
  if (eric.length === 0) {
    emit({ reason: "no-acme", picked: models[0], confidence: null, scores: {}, preview: "", classifierMs: null });
    return null;
  }

  // A combo with no Kiro member cannot run the code guard: a "code" turn would
  // have no safe destination. Bail out and let the caller keep the combo order —
  // a sentryforge combo is expected to always include at least one Kiro member,
  // so this only fires on a misconfigured combo, and it is flagged in the
  // routing dashboard as "no-kiro" rather than passing silently.
  if (kiro.length === 0) {
    emit({ reason: "no-kiro", picked: null, confidence: null, scores: {}, preview: "", classifierMs: null });
    return null;
  }

  // Kiro-only serve order (health-ranked). Used for every fail-closed outcome so
  // the failover loop can never fall through to an Acme model on those turns.
  const kiroServeOrder = (requireServiceable = false) => {
    const now = Date.now();
    const pool = requireServiceable ? serviceable(kiro, requiredCapabilities) : kiro;
    const ranked = pool.length ? dehealth(pool, now) : [];
    return ranked.length ? ranked : [...kiro];
  };

  const { userText, continuation } = extractTurn(body);
  const preview = userText.slice(0, 200);
  if (!userText.trim()) {
    emit({ reason: "no-user-text", picked: kiroServeOrder()[0], confidence: null, scores: {}, preview, classifierMs: null });
    return kiroServeOrder();
  }

  const url = cfg.url || SENTRY_DEFAULTS.url;
  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : SENTRY_DEFAULTS.timeoutMs;
  const apiKey = cfg.apiKey || SENTRY_DEFAULTS.apiKey;
  const codeGate = Number.isFinite(cfg.codeConfidenceGate) ? cfg.codeConfidenceGate : SENTRY_DEFAULTS.codeConfidenceGate;

  // Candidate rubric: provider prefix hints at the *safety* of a pick without
  // doing CLEF's job. Deliberately one line each; the guard, not the rubric,
  // is what prevents code from crossing pools.
  const criteria = {};
  for (const m of models) {
    criteria[m] = isKiroModel(m)
      ? `${m} (Kiro tier — the only pool allowed for agentic executable-file writes in git)`
      : `${m} (Acme free local model — all turns that do not mutate executable project files; answers and markdown docs may contain example code snippets)`;
  }

  const request = {
    model: cfg.model || SENTRY_DEFAULTS.model,
    state: {
      kind: continuation ? "tool-step continuation in an ongoing agent session" : "fresh user turn",
      userRequest: userText,
    },
    questions: {
      kind: {
        type: "choice",
        instructions: classificationKind(),
        criteria: { code: null, noncode: null },
      },
      route: {
        type: "choice",
        instructions: "Which candidate should serve this request? Prefer Acme for any turn that does not mutate executable project files in git (answers and markdown docs may contain example code snippets); use Kiro only when the agent is asked to create or modify executable project files.",
        criteria,
      },
    },
  };

  const t0 = Date.now();
  let answers;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const order = kiroServeOrder();
      log?.warn?.("SENTRYFORGE", `Classifier HTTP ${res.status}, serving Kiro`);
      emit({ reason: `http-${res.status}`, picked: order[0], confidence: null, scores: {}, preview, classifierMs: Date.now() - t0 });
      return order;
    }
    answers = parseDecisionBody(await res.text())?.answers;
  } catch (err) {
    const order = kiroServeOrder();
    log?.warn?.("SENTRYFORGE", `Classifier failed (${err?.name === "TimeoutError" ? "timeout" : err?.message || "error"}), serving Kiro`);
    emit({ reason: err?.name === "TimeoutError" ? "timeout" : "error", picked: order[0], confidence: null, scores: {}, preview, classifierMs: Date.now() - t0 });
    return order;
  }
  const elapsed = Date.now() - t0;

  const kindRaw = answers?.kind;
  const kind = typeof kindRaw?.choice === "string" ? kindRaw.choice.trim().toLowerCase() : "";
  const kindConfidence = typeof kindRaw?.confidence === "number" ? kindRaw.confidence : null;
  const kindUnknown = kind !== "code" && kind !== "noncode";

  const routeRaw = answers?.route;
  const routeChoice = typeof routeRaw?.choice === "string" ? routeRaw.choice.trim() : "";
  const routeConfidence = typeof routeRaw?.confidence === "number" ? routeRaw.confidence : null;
  const probabilities = routeRaw?.probabilities && typeof routeRaw.probabilities === "object" ? routeRaw.probabilities : {};

  // Missing kind, or a "noncode" label too weak to trust with Acme → Kiro-only.
  if (kindUnknown || (kind === "noncode" && typeof kindConfidence === "number" && kindConfidence < codeGate)) {
    const order = kiroServeOrder(true);
    const reason = kindUnknown ? "guard-no-kind" : "guard-low-confidence";
    log?.info?.("SENTRYFORGE", `Unsafe to trust Acme (kind=${kind || "missing"}, conf=${kindConfidence ?? "n/a"}), serving Kiro`);
    emit({ reason, picked: order[0], confidence: kindConfidence, scores: { kind, kindConfidence, route: routeChoice, probabilities }, preview, classifierMs: elapsed });
    return order;
  }

  if (kind === "code") {
    const now = Date.now();
    const svc = serviceable(kiro, requiredCapabilities);
    const ranked = svc.length ? dehealth(svc, now) : [...kiro];
    // CLEF's route pick is honored only when it names a Kiro member.
    const pick = routeChoice && isKiroModel(routeChoice) && models.includes(routeChoice) ? routeChoice : ranked[0];
    const rest = ranked.filter((m) => m !== pick);
    log?.info?.("SENTRYFORGE", `Code turn → Kiro ${pick}`);
    emit({ reason: "code-kiro", picked: pick, confidence: routeConfidence, scores: { kind, kindConfidence, route: routeChoice, probabilities }, preview, classifierMs: elapsed });
    return [pick, ...rest];
  }

  // Confident non-code → prefer Acme (Kiro kept as the tail for failover).
  const now = Date.now();
  const svcEric = serviceable(eric, requiredCapabilities);
  const rankedEric = svcEric.length ? dehealth(svcEric, now) : [];
  const ericPick = (routeChoice && !isKiroModel(routeChoice) && svcEric.includes(routeChoice))
    ? routeChoice
    : rankedEric[0] || null;

  if (ericPick) {
    const restEric = rankedEric.filter((m) => m !== ericPick);
    const tailKiro = dehealth(kiro, now);
    log?.info?.("SENTRYFORGE", `Non-code turn → Acme ${ericPick}`);
    emit({ reason: "noncode-acme", picked: ericPick, confidence: routeConfidence, scores: { kind, kindConfidence, route: routeChoice, probabilities }, preview, classifierMs: elapsed });
    return [ericPick, ...restEric, ...tailKiro];
  }

  // No servable Acme member → Kiro.
  const order = kiroServeOrder(true);
  log?.info?.("SENTRYFORGE", `Non-code but no servable Acme → Kiro ${order[0]}`);
  emit({ reason: "noncode-kiro-fallback", picked: order[0], confidence: routeConfidence, scores: { kind, kindConfidence, route: routeChoice, probabilities }, preview, classifierMs: elapsed });
  return order;
}