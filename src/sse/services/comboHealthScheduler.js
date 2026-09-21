// Background reachability ticker for combo models.
//
// Every cycle it collects the unique models across all combos and probes
// them through the existing /api/models/test path (pingModelByKind), which
// runs the real provider route but never touches 9router's account
// backoff — so a dead model cannot walk up the shared account's cooldown
// and lock out the healthy models that share it.
//
// Probes are capped at 15s on the client side; the abort cascades to the
// upstream fetch via the handler's disconnect path, so a hanging upstream
// costs one probe's worth, not the old 60s×4 combo penalty.
//
// Fail-open everywhere: a tick error or per-model probe failure never kills
// the interval and never affects live routing.

import { getCombos } from "@/lib/db/repos/combosRepo.js";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { pingModelByKind } from "@/app/api/models/test/ping.js";
import * as log from "../utils/logger.js";
import {
  recordProbeResult,
  getOfflineModels,
  isModelStable,
  forgetModels,
  forgetModelsExcept,
} from "./comboHealth.js";

const DEFAULT_INTERVAL_MS = 60 * 1000;
const INITIAL_DELAY_MS = 15 * 1000;
const PROBE_TIMEOUT_MS = 15000;
const PROBE_CONCURRENCY = 3;

// Probe cadence, ms. Overridable via COMBO_HEALTH_INTERVAL_MS so the probe
// load (one completion per unique combo model per tick) can be dialed down if
// it becomes noticeable on billed upstreams. 60s is the default: frequent
// enough to evict a dead member within ~2 ticks, cheap enough that a 32-token
// probe per model is trivial on the local ericaiproxy GPU.
export function readIntervalMs() {
  const raw = process.env.COMBO_HEALTH_INTERVAL_MS;
  if (raw == null || raw === "") return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_INTERVAL_MS;
}

// State on globalThis so a module re-evaluation (standalone double-import,
// HMR) can't fork a second interval alongside the first — same idiom as
// initializeApp's __appSingleton.
const state = (globalThis.__comboHealthScheduler ??= { started: false, intervalHandle: null, initialTimeoutHandle: null, tickRunning: false, lastProbeAt: new Map() });
const isStarted = () => state.started;
const isTickRunning = () => state.tickRunning;

function isTruthyEnv(value) {
  if (value == null || value === "") return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") return true;
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

function baseUrl() {
  return `http://127.0.0.1:${process.env.PORT || 20128}`;
}

// A hang here costs at most PROBE_TIMEOUT_MS: the client-side abort closes the
// connection, and the /v1 handler's onDisconnect cascades the abort to the
// upstream fetch. max_tokens stays tiny — a reachability probe needs any
// completion, not a 1024-token answer (the interactive test keeps 1024 for
// reasoning-model prefill, see issue #3010).
async function defaultProbe(model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const result = await pingModelByKind(model, "llm", baseUrl(), { maxTokens: 32 });
    return { ok: result.ok, error: result.error ?? null };
  } catch (err) {
    const detail = err?.cause?.code ? ` (${err.cause.code})` : "";
    return { ok: false, error: err?.name === "AbortError" ? `probe timeout after ${PROBE_TIMEOUT_MS}ms` : `probe threw: ${err?.message || String(err)}${detail}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `probe` over `models` with at most `concurrency` in flight, preserving
 * result order. Fail-open per item (a rejection becomes a {ok:false} entry)
 * so one bad probe can't reject the whole tick.
 * @param {string[]} models
 * @param {(m: string) => Promise<{ok: boolean, error?: string|null}>} probe
 * @param {number} concurrency
 * @returns {Promise<Array<{ok: boolean, error?: string|null}>>}
 */
async function probeAll(models, probe, concurrency) {
  const out = new Array(models.length);
  let next = 0;
  async function worker() {
    while (next < models.length) {
      const i = next++;
      const m = models[i];
      try { out[i] = await probe(m); }
      catch (e) { out[i] = { ok: false, error: `probe threw: ${e?.message || String(e)}` }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, models.length) }, worker));
  return out;
}

/**
 * Per-combo health-monitor settings come from settings.comboStrategies
 * (name-keyed blob, same channel as the strategy picker):
 *   health: true|false        — default true (absent = monitored, so existing
 *                               combos keep the current behavior)
 *   healthIntervalMin: number — probe cadence in minutes, default 60
 * The base tick still runs on the (env-tunable) 60s period. A model's
 * interval is the fastest among its monitored combos, but it only gates
 * STABLE models (online, zero failures): a model that recently failed or is
 * offline is probed every tick so eviction/recovery stays ~1 tick no matter
 * the cadence. A model whose combos are all unmonitored is skipped AND its
 * registry state is cleared (unknown = online), so toggling monitoring off
 * restores full-list routing instantly.
 * @param {Array<{name?: string, models?: string[]}>} combos
 * @param {Record<string, object|undefined>} comboStrategies
 * @returns {{ byModel: Map<string, number>, forgotten: string[], allModels: Set<string> }}
 */
function planProbe(combos, comboStrategies) {
  const byModel = new Map();
  const allModels = new Set();
  for (const combo of combos || []) {
    const cfg = (comboStrategies || {})[combo?.name] || {};
    const monitored = cfg.health !== false;
    const intervalMs = (Number(cfg.healthIntervalMin) > 0 ? Number(cfg.healthIntervalMin) : 60) * 60000;
    for (const m of combo?.models || []) {
      if (!m) continue;
      allModels.add(m);
      if (monitored) byModel.set(m, Math.min(byModel.get(m) ?? Infinity, intervalMs));
    }
  }
  // Forgotten = member of some combo but of NO monitored one. (A model that is
  // also in a monitored combo stays probed at that combo's cadence.)
  const forgotten = [...allModels].filter((m) => !byModel.has(m));
  return { byModel, forgotten, allModels };
}

/**
 * One scheduler tick. Fail-open at top level and per model.
 * @param {{ loadCombos?: Function, loadSettings?: Function, probe?: Function, now?: Function }} [deps]
 */
export async function runComboHealthTick(deps = {}) {
  if (isTickRunning()) return;
  state.tickRunning = true;
  try {
    const load = deps.loadCombos || getCombos;
    const loadSettings = deps.loadSettings || getSettings;
    const probe = deps.probe || defaultProbe;
    const now = deps.now || Date.now;

    const combos = await load();
    // Fail-open: a settings read error means "monitor everything at the
    // default cadence", not "skip the tick" — the health check is the point.
    let comboStrategies = {};
    try {
      const settings = await loadSettings();
      comboStrategies = settings?.comboStrategies || {};
    } catch {
      comboStrategies = {};
    }
    const { byModel, forgotten, allModels } = planProbe(combos, comboStrategies);

    if (forgotten.length) {
      forgetModels(forgotten);
      log.info("COMBO_HEALTH", `Monitoring disabled for ${forgotten.length} model(s)`, { forgotten });
    }
    // Shed state for models that are no longer members of ANY combo (combo
    // deleted or member edited out) so a stale offline flag can't resurface.
    forgetModelsExcept(allModels);
    for (const m of [...state.lastProbeAt.keys()]) {
      if (!allModels.has(m)) state.lastProbeAt.delete(m);
    }

    const ts = now();
    const seen = new Set();
    const models = [];
    for (const [m, intervalMs] of byModel) {
      // Interval-gate only stable models: a suspect/offline one must be
      // re-probed every tick so failover never waits out a long cadence.
      if (isModelStable(m)) {
        const last = state.lastProbeAt.get(m);
        if (last != null && ts - last < intervalMs) continue; // inside window
      }
      if (!seen.has(m)) { seen.add(m); models.push(m); }
    }
    if (models.length === 0) return;

    // Probe in a small pool, not all-at-once: N concurrent non-streaming
    // completions to one backend is enough load to make a healthy model time
    // out and flip offline (observed on the first tick). Cap keeps the checker
    // from becoming the thing that looks broken.
    const results = await probeAll(models, probe, PROBE_CONCURRENCY);
    const transitions = [];
    results.forEach((r, i) => {
      const model = models[i];
      state.lastProbeAt.set(model, now());
      const event = recordProbeResult(model, { ok: !!r.ok, error: r.error ?? null });
      if (event) {
        transitions.push(`${model} → ${event}`);
        if (event === "offline") log.warn("COMBO_HEALTH", `Model ${model} is now offline`, { error: r.error || undefined });
        else log.info("COMBO_HEALTH", `Model ${model} is now online`);
      }
    });
    if (transitions.length) log.info("COMBO_HEALTH", `Transitions: ${transitions.join("; ")}`);
    const offline = getOfflineModels();
    if (offline.length) log.debug("COMBO_HEALTH", `Offline: ${offline.join(", ")}`);
  } catch (err) {
    log.warn("COMBO_HEALTH", "Tick failed (swallowed)", { error: err?.message ?? String(err) });
  } finally {
    state.tickRunning = false;
  }
}

/**
 * Start the combo health ticker. Idempotent; no-op if already started or
 * disabled via DISABLE_COMBO_HEALTH.
 * @param {{ intervalMs?: number }} [opts]
 * @returns {boolean} true if started this call
 */
export function startComboHealthScheduler({ intervalMs } = {}) {
  if (isStarted()) return false;
  if (isTruthyEnv(process.env.DISABLE_COMBO_HEALTH)) return false;
  if (isNonServerRuntime()) return false;

  state.started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : readIntervalMs();

  const safeTick = () => {
    runComboHealthTick().catch((err) => {
      log.warn("COMBO_HEALTH", "Unhandled tick rejection (swallowed)", { error: err?.message ?? String(err) });
    });
  };

  state.initialTimeoutHandle = setTimeout(safeTick, INITIAL_DELAY_MS);
  if (state.initialTimeoutHandle.unref) state.initialTimeoutHandle.unref();

  state.intervalHandle = setInterval(safeTick, period);
  if (state.intervalHandle.unref) state.intervalHandle.unref();

  log.info("COMBO_HEALTH", `Ticker started (every ${period / 1000}s)`);
  return true;
}

export function stopComboHealthScheduler() {
  if (state.initialTimeoutHandle) { clearTimeout(state.initialTimeoutHandle); state.initialTimeoutHandle = null; }
  if (state.intervalHandle) { clearInterval(state.intervalHandle); state.intervalHandle = null; }
  if (state.started) state.started = false;
}
