// Combo model health registry — online/offline state per model.
//
// A background scheduler (comboHealthScheduler.js) probes every model that
// appears in any combo; this module only tracks the results and exposes a
// filter that routing uses to skip offline models. The stored combo list is
// never mutated, so a recovered model reappears automatically and the
// dashboard's editor (which saves the full list) stays the source of truth.
//
// In-memory only, like the adaptive-state and round-robin routing state: a
// restart loses the registry, which is safe — unknown models are assumed
// online, i.e. the configured combo order is the fallback behavior.
//
// The map lives on globalThis (same idiom as initializeApp's __appSingleton):
// the ticker is started from instrumentation.js at server boot and the filter
// is called from the route handlers, and a module re-evaluation (standalone
// double-import, HMR) must not fork them into two registries.

// Consecutive failed probes before a model is marked offline. Two, not one:
// a single transient 500 (upstream restart, DNS blip) must not yank a healthy
// model out of every combo.
export const OFFLINE_THRESHOLD = 2;

const store = (globalThis.__comboHealth ??= { models: new Map() });

/** @type {Map<string, { fails: number, offline: boolean, lastError: string|null, updatedAt: number }>} */
const modelHealth = store.models;

/**
 * Record one probe result for a model.
 * @param {string} model combo model string ("provider/model")
 * @param {{ ok: boolean, error?: string|null }} result
 * @returns {"offline"|"online"|null} the transition event, if any
 */
export function recordProbeResult(model, result) {
  let h = modelHealth.get(model);
  if (!h) {
    h = { fails: 0, offline: false, lastError: null, updatedAt: Date.now() };
    modelHealth.set(model, h);
  }
  h.updatedAt = Date.now();

  if (result.ok) {
    const wasOffline = h.offline;
    h.fails = 0;
    h.lastError = null;
    h.offline = false;
    return wasOffline ? "online" : null;
  }

  h.fails += 1;
  h.lastError = result.error || "probe failed";
  if (!h.offline && h.fails >= OFFLINE_THRESHOLD) {
    h.offline = true;
    return "offline";
  }
  return null;
}

/** @param {string} model @returns {boolean} */
export function isModelOffline(model) {
  return modelHealth.get(model)?.offline === true;
}

/**
 * True when the model has probe history and no open issue: online with zero
 * consecutive failures. Suspect (recent fail) or offline models are NOT
 * stable — the scheduler probes those every tick so eviction/recovery stays
 * at ~1 tick regardless of the per-combo probe interval.
 * @param {string} model @returns {boolean}
 */
export function isModelStable(model) {
  const h = modelHealth.get(model);
  return !!h && !h.offline && h.fails === 0;
}

/** @returns {string[]} every model currently marked offline */
export function getOfflineModels() {
  const out = [];
  for (const [model, h] of modelHealth) if (h.offline) out.push(model);
  return out;
}

/**
 * Remove offline models from a combo's list, preserving order.
 * Never returns an empty list: if every model is offline the original order is
 * kept, so the normal fallback loop still runs and reports "all models
 * failed" instead of a combo with nothing to route to.
 * @param {string[]} models
 * @returns {string[]}
 */
export function filterOfflineModels(models) {
  if (!Array.isArray(models) || models.length === 0) return models || [];
  const live = models.filter((m) => !isModelOffline(m));
  return live.length > 0 ? live : models;
}

/**
 * Drop registry entries for models no longer covered by any combo that has
 * health monitoring enabled (user toggled it off). They become "unknown"
 * again: the filter passes them through and the ticker stops probing them
 * until monitoring is re-enabled.
 * @param {string[]} models
 */
export function forgetModels(models) {
  for (const m of models || []) modelHealth.delete(m);
}

/**
 * Drop every registry entry whose model is not in `keep` — used each tick to
 * shed state for models that left all combos (combo deleted, member edited
 * out), so a stale offline flag can't resurface when a model reappears.
 * @param {Set<string>} keep
 */
export function forgetModelsExcept(keep) {
  for (const m of [...modelHealth.keys()]) if (!keep.has(m)) modelHealth.delete(m);
}

/** Test hook: clear all health state. */
export function resetComboHealth() {
  modelHealth.clear();
}
