/**
 * Composite-stage combo strategy: classifier on new user turns, trajectory-based
 * stage routing on tool-loop turns, capable-first when the evidence is ambiguous.
 *
 * The strategy only *selects* a model. The chosen model then goes through the same
 * `handleSingleModel` path every other combo strategy uses, so tool calls, tool
 * definitions, streaming, thinking configuration and provider-specific normalization
 * are all handled by the existing adapter stack — the body is passed through
 * untouched. That is what makes a mid-loop tier switch safe.
 *
 * A routing failure is never allowed to fail the request: the classifier resolves to
 * the capable tier, a scorer exception keeps the current tier, and an unavailable
 * efficient model falls back to the capable one.
 */

import { classifyTier, CLASSIFIER_DEFAULTS } from "./classifier.js";
import { scoreStage, STAGE_DEFAULTS } from "./stage-scorer.js";
import { getRoutingState, touchRoutingState, fingerprintTurn, TIER, CLASSIFICATION_UNKNOWN } from "./session-state.js";
import { classifyTrailingTurn } from "./trajectory.js";

export const PICKER = {
  CAPABLE_FIRST: "capable_first",
  EFFICIENT_FIRST: "efficient_first",
};

export const COMPOSITE_DEFAULTS = {
  picker: PICKER.CAPABLE_FIRST,
  // Classifier confidence needed to act on an against-the-grain classification
  // (EFFICIENT under capable_first, CAPABLE under efficient_first).
  threshold: 0.75,
  // Asymmetric on purpose: escalating to capable is cheap insurance, downgrading
  // risks a bad turn, so leaving capable demands much stronger evidence than
  // staying on it. This asymmetry is the anti-oscillation mechanism.
  upgradeThreshold: 0.50,
  downgradeThreshold: 0.25,
  hysteresis: true,
  classifier: { ...CLASSIFIER_DEFAULTS },
  stage: { ...STAGE_DEFAULTS },
};

/**
 * Resolve capable/efficient models. Explicit settings win; otherwise the combo's
 * own model list supplies them (first = capable, second = efficient), so a combo
 * works the moment the strategy is selected, before anything is configured.
 *
 * @param {string[]} models - Combo member models.
 * @param {object} cfg - Per-combo strategy settings.
 * @returns {{ capable: string|null, efficient: string|null, classifier: string|null }}
 */
export function resolveTierModels(models, cfg = {}) {
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  const pick = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const capable = pick(cfg.capableModel) || list[0] || null;
  const efficient = pick(cfg.efficientModel) || list.find((m) => m !== capable) || null;
  return { capable, efficient, classifier: pick(cfg.classifierModel) };
}

/**
 * Decide the tier for a turn from the classifier result, under the active picker.
 * Exported for tests — the threshold semantics are the crux of capable-first.
 *
 * @param {{tier: string, confidence: number}} result
 * @param {object} cfg
 * @returns {string} TIER value
 */
export function pickInitialTier(result, cfg) {
  const picker = cfg.picker || PICKER.CAPABLE_FIRST;
  const threshold = numberOr(cfg.threshold, COMPOSITE_DEFAULTS.threshold);
  const tier = result?.tier;
  const confidence = numberOr(result?.confidence, 0);

  if (picker === PICKER.EFFICIENT_FIRST) {
    // Mirror image: default efficient, escalate only on a confident CAPABLE call.
    return tier === TIER.CAPABLE && confidence >= threshold ? TIER.CAPABLE : TIER.EFFICIENT;
  }
  // capable_first: only a confident EFFICIENT call moves work off the capable model.
  return tier === TIER.EFFICIENT && confidence >= threshold ? TIER.EFFICIENT : TIER.CAPABLE;
}

/**
 * Decide the tier for a tool-loop turn from the stage score.
 * Exported for tests — this is where hysteresis lives.
 *
 * @param {object} stage - Result of scoreStage().
 * @param {string} currentTier - Tier used on the previous turn.
 * @param {object} cfg
 * @returns {{ tier: string, reason: string }}
 */
export function pickStageTier(stage, currentTier, cfg) {
  const upgrade = numberOr(cfg.upgradeThreshold, COMPOSITE_DEFAULTS.upgradeThreshold);
  const downgrade = numberOr(cfg.downgradeThreshold, COMPOSITE_DEFAULTS.downgradeThreshold);
  const hysteresis = cfg.hysteresis !== false;

  if (stage?.criticalError) return { tier: TIER.CAPABLE, reason: "critical error override" };
  // No tool activity yet means no evidence; changing tier here would be a coin flip.
  if (!stage?.hasEvidence) return { tier: currentTier, reason: "no trajectory evidence" };

  const score = numberOr(stage.score, 0);
  if (score >= upgrade) return { tier: TIER.CAPABLE, reason: `stage score ${score.toFixed(2)} ≥ upgrade ${upgrade}` };
  if (score <= downgrade) return { tier: TIER.EFFICIENT, reason: `stage score ${score.toFixed(2)} ≤ downgrade ${downgrade}` };

  // Between the thresholds: with hysteresis, stay put (this is what stops
  // Opus↔M2.5 flapping across a long tool loop). Without it, ambiguity means
  // capable, per the quality-first principle.
  if (hysteresis) return { tier: currentTier, reason: `stage score ${score.toFixed(2)} in hysteresis band` };
  return { tier: TIER.CAPABLE, reason: "ambiguous → capable" };
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Run the composite-stage strategy for one request.
 *
 * @param {object} options
 * @param {object} options.body - Request body in client format (passed through unmodified).
 * @param {string[]} options.models - Combo member models.
 * @param {Function} options.handleSingleModel - (body, modelStr, isPanel) => Promise<Response>
 * @param {object} options.log - Logger.
 * @param {string} [options.comboName] - Combo name (state key + logging).
 * @param {string} [options.sessionId] - Conversation-stable id; state is per (combo, session).
 * @param {object} [options.config] - Per-combo strategy settings.
 * @returns {Promise<Response>}
 */
export async function handleCompositeStageChat({ body, models, handleSingleModel, log, comboName, sessionId, config = {} }) {
  const cfg = {
    ...COMPOSITE_DEFAULTS,
    ...config,
    classifier: { ...COMPOSITE_DEFAULTS.classifier, ...(config.classifier || {}) },
    stage: { ...COMPOSITE_DEFAULTS.stage, ...(config.stage || {}) },
  };

  const { capable, efficient, classifier } = resolveTierModels(models, cfg);
  if (!capable) {
    return new Response(
      JSON.stringify({ error: { message: "Composite combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const state = getRoutingState(comboName, sessionId);
  state.turnCounter++;
  const previousTier = state.currentTier;

  const turn = classifyTrailingTurn(body);
  const decision = await decideTier({ body, turn, state, cfg, classifier, handleSingleModel, log });

  state.currentTier = decision.tier;
  state.lastStageScore = decision.stageScore ?? state.lastStageScore;
  if (decision.tier !== previousTier) {
    if (decision.tier === TIER.CAPABLE) state.escalations++;
    else state.downgrades++;
  }
  touchRoutingState(comboName, sessionId);

  // Nothing to route to: a single-model combo, or no efficient model configured.
  const wantsEfficient = decision.tier === TIER.EFFICIENT;
  const target = wantsEfficient && efficient ? efficient : capable;
  const effectiveTier = target === capable ? TIER.CAPABLE : TIER.EFFICIENT;
  if (wantsEfficient && !efficient) {
    state.currentTier = TIER.CAPABLE;
    decision.reason = `${decision.reason} (no efficient model → capable)`;
  }

  logDecision(log, {
    comboName,
    sessionId,
    turn: state.turnCounter,
    turnKind: turn.kind,
    previousTier,
    selectedTier: effectiveTier,
    selectedModel: target,
    decision,
    state,
  });

  const res = await handleSingleModel(body, target);

  // Efficient model unavailable → retry once on capable rather than surfacing the
  // error. Only for the efficient tier: a failing capable model is left to the
  // caller's existing account-fallback/retry behavior.
  if (res && !res.ok && effectiveTier === TIER.EFFICIENT && target !== capable) {
    log.warn("COMPOSITE", `Efficient ${target} failed (${res.status}) → capable ${capable}`);
    state.currentTier = TIER.CAPABLE;
    state.escalations++;
    touchRoutingState(comboName, sessionId);
    return handleSingleModel(body, capable);
  }

  return res;
}

/**
 * Pick a tier for this turn: classify a new user turn, score the trajectory on a
 * tool-loop continuation. Never throws — a scorer failure retains the current tier.
 */
async function decideTier({ body, turn, state, cfg, classifier, handleSingleModel, log }) {
  // New user turn → classifier. A retried identical turn reuses the stored decision
  // so a client retry doesn't pay for a second classification.
  if (turn.kind === "user") {
    const fingerprint = fingerprintTurn(turn.text);
    const isRepeat = fingerprint && fingerprint === state.lastUserTurnFingerprint;

    if (isRepeat && state.lastClassifierDecision) {
      const tier = pickInitialTier(state.lastClassifierDecision, cfg);
      return { tier, source: "classifier-cached", reason: "repeated user turn", classifier: state.lastClassifierDecision };
    }

    if (cfg.classifier?.enabled === false || !classifier) {
      // Without a classifier the picker's default applies: capable under capable_first.
      const tier = cfg.picker === PICKER.EFFICIENT_FIRST ? TIER.EFFICIENT : TIER.CAPABLE;
      state.initialClassification = CLASSIFICATION_UNKNOWN;
      state.lastUserTurnFingerprint = fingerprint;
      return { tier, source: "picker-default", reason: classifier ? "classifier disabled" : "no classifier model" };
    }

    const result = await classifyTier({
      userText: turn.text,
      classifierModel: classifier,
      handleSingleModel,
      cfg: cfg.classifier,
    });

    state.initialClassification = result.tier;
    state.lastClassifierDecision = { tier: result.tier, confidence: result.confidence };
    state.classifierTimestamp = Date.now();
    state.lastUserTurnFingerprint = fingerprint;

    const tier = pickInitialTier(result, cfg);
    return { tier, source: "classifier", reason: result.reason, classifier: state.lastClassifierDecision };
  }

  // Tool continuation (or an unreadable turn) → stage routing on the trajectory.
  if (cfg.stage?.enabled === false) {
    return { tier: state.currentTier, source: "stage-disabled", reason: "stage routing disabled" };
  }

  try {
    const stage = scoreStage({ body, cfg: cfg.stage });
    const { tier, reason } = pickStageTier(stage, state.currentTier, cfg);
    return { tier, source: "stage", reason, stageScore: stage.score, signals: stage.signals };
  } catch (error) {
    log.warn("COMPOSITE", `Stage scoring failed, keeping ${state.currentTier}`, { error: error?.message || String(error) });
    return { tier: state.currentTier, source: "stage-error", reason: "stage scoring exception" };
  }
}

/**
 * Emit one structured line per routing decision. Carries only derived metrics —
 * no prompt text, no classifier reasoning — so routing stays explainable without
 * logging conversation content.
 */
function logDecision(log, { comboName, sessionId, turn, turnKind, previousTier, selectedTier, selectedModel, decision, state }) {
  const payload = {
    strategy: "composite-stage",
    combo: comboName || null,
    // Sessions ids can embed client identifiers; a short suffix is enough to
    // correlate turns of one conversation in the log without recording it.
    session: sessionId ? String(sessionId).slice(-12) : null,
    turn,
    turnKind,
    previousTier,
    selectedTier,
    selectedModel,
    source: decision.source,
    reason: decision.reason,
    escalations: state.escalations,
    downgrades: state.downgrades,
  };
  if (decision.classifier) {
    payload.classifierTier = decision.classifier.tier;
    payload.classifierConfidence = decision.classifier.confidence;
  }
  if (decision.stageScore !== undefined) payload.stageScore = round2(decision.stageScore);
  if (decision.signals) payload.signals = decision.signals;

  const arrow = previousTier === selectedTier ? "=" : previousTier === TIER.CAPABLE ? "↓" : "↑";
  log.info("COMPOSITE", `${arrow} turn ${turn} (${turnKind}) ${previousTier}→${selectedTier} ${selectedModel} | ${decision.source}: ${decision.reason}`, payload);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
