/**
 * Adaptive connect timeout — per-provider time-to-response-headers tracker.
 *
 * The static FETCH_CONNECT_TIMEOUT_MS has to serve two contradictory masters:
 * generous enough for a slow-inference upstream (an idle Ray autoscaler can
 * take 60s+ to return headers), tight enough that a dead backend fails over
 * fast. One number cannot do both, and every manual tune re-opens the other
 * half of the trade. This module learns the number per provider instead:
 * record time-to-headers on successful responses, and suggest p95 × headroom
 * as the timeout — a provider that answers in 2s gets a 4s budget (dead ⇒
 * fail over in 4s), a provider that needs 40s keeps a generous one.
 *
 * Guardrails, because a timeout is a footgun in both directions:
 * - Tighten-only: the suggestion is clamped to [floor, ceiling] where the
 *   ceiling is the static timeout. Adaptive can only ever fail you over
 *   faster than a manual tune, never slower — a stale or noisy window can
 *   make the router twitchy, but never hung.
 * - Success samples only: the caller records 2xx header-latency exclusively.
 *   A 5xx that answers in 50ms (health proxy alive, model dead) must not
 *   teach the tracker that the provider is fast.
 * - Warmup: fewer than MIN_SAMPLES recent samples ⇒ no suggestion (null),
 *   fall through to the static timeout. One lucky fast request must not
 *   tighten everyone's budget to 2s.
 * - Freshness: samples older than the window are pruned on read, so a
 *   provider that got permanently slow gets its old fast samples dropped and
 *   its suggestion decays back toward the ceiling until new slow samples
 *   arrive — matching what the name "adaptive" should promise.
 * - Eviction on connect timeout: a timing-out provider's window is dropped
 *   outright. Its stale fast samples would otherwise keep the budget tight
 *   and starve a recovering (now slower) provider — the starved requests
 *   never succeed, so the window could never learn on its own.
 *
 * Keyed by provider id (not model): an openai-compatible connection is one
 * upstream, and per-model keys would fragment the samples across a combo's
 * models and keep each one below the warmup threshold.
 *
 * In-memory only, like every other routing signal: a restart loses the
 * window, which just means providers run on the static timeout until the
 * window refills. No persistence for a signal this ephemeral.
 *
 * Opt-in via ADAPTIVE_CONNECT_TIMEOUT=1; with the flag off, suggestTimeout()
 * always returns null and the behavior is exactly the pre-feature static one.
 */

import {
  ADAPTIVE_CONNECT_TIMEOUT,
  ADAPTIVE_TIMEOUT_MIN_SAMPLES,
  ADAPTIVE_TIMEOUT_HEADROOM,
  ADAPTIVE_TIMEOUT_FLOOR_MS,
  FETCH_CONNECT_TIMEOUT_MS,
} from "../config/runtimeConfig.js";

// Rolling window for samples. Long enough that a burst of requests covers a
// real traffic pattern, short enough that a provider regression shows up in
// the suggestion within minutes rather than hours.
const WINDOW_MS = 10 * 60 * 1000;

// Hard cap on stored samples per provider (memory bound; WINDOW_MS is the
// semantic limit, this is just the belt).
const CAP = 50;

/** @type {Map<string, Array<{t: number, ms: number}>>} */
const samplesByProvider = new Map();

/** @type {Map<string, number>} */
const evictionsByProvider = new Map();

let observerTimer = null;

/**
 * Record one successful response's time-to-headers.
 * Called from the request path on every 2xx; must stay allocation-light.
 */
export function recordLatency(provider, ttftMs, now = Date.now()) {
  if (!ADAPTIVE_CONNECT_TIMEOUT || !provider) return;
  if (!Number.isFinite(ttftMs) || ttftMs < 0) return;

  let arr = samplesByProvider.get(provider);
  if (!arr) {
    arr = [];
    samplesByProvider.set(provider, arr);
  }
  arr.push({ t: now, ms: ttftMs });
  if (arr.length > CAP) arr.splice(0, arr.length - CAP);
}

// Nearest-rank percentile on an already-extracted sorted array.
function percentile(sorted, q) {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.ceil(q * sorted.length) - 1);
  return sorted[idx];
}

/**
 * Suggest a connect timeout for a provider, or null (caller falls back to
 * the static timeout). Null when: feature off, window below MIN_SAMPLES,
 * or every sample has aged out.
 */
export function suggestTimeout(provider, now = Date.now()) {
  if (!ADAPTIVE_CONNECT_TIMEOUT || !provider) return null;

  const arr = samplesByProvider.get(provider);
  if (!arr) return null;

  const cutoff = now - WINDOW_MS;
  // Prune in place; samples arrive in time order so the stale prefix is contiguous.
  let firstFresh = 0;
  while (firstFresh < arr.length && arr[firstFresh].t < cutoff) firstFresh++;
  if (firstFresh > 0) arr.splice(0, firstFresh);
  if (arr.length < ADAPTIVE_TIMEOUT_MIN_SAMPLES) return null;

  const p95 = percentile(arr.map((s) => s.ms).sort((a, b) => a - b), 0.95);
  if (p95 == null) return null;

  const suggested = Math.round(p95 * ADAPTIVE_TIMEOUT_HEADROOM);
  // Tighten-only, jitter-bounded: clamp to [floor, ceiling].
  return Math.min(Math.max(suggested, ADAPTIVE_TIMEOUT_FLOOR_MS), FETCH_CONNECT_TIMEOUT_MS);
}

/**
 * Drop a provider's latency window — called when a request times out at the
 * connect phase. The provider then runs on the static timeout until
 * MIN_SAMPLES fresh samples re-tighten it, so a recovering-but-slower
 * upstream is not strangled by the budget it earned while healthy.
 */
export function evictProvider(provider) {
  if (provider) {
    samplesByProvider.delete(provider);
    evictionsByProvider.set(provider, (evictionsByProvider.get(provider) || 0) + 1);
  }
}

/**
 * One-line, per-provider summary of the live latency window — the observability
 * hook for tuning. Rows are only emitted for providers over the warmup
 * threshold, so it stays quiet when nothing is adaptive-active.
 */
export function getTrackerSummary(now = Date.now()) {
  const rows = [];
  for (const [provider, arr] of samplesByProvider) {
    const cutoff = now - WINDOW_MS;
    const fresh = arr.filter((s) => s.t >= cutoff);
    if (fresh.length < ADAPTIVE_TIMEOUT_MIN_SAMPLES) continue;
    const sorted = fresh.map((s) => s.ms).sort((a, b) => a - b);
    rows.push({
      provider,
      samples: fresh.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      suggested: suggestTimeout(provider, now),
      evictions: evictionsByProvider.get(provider) || 0,
    });
  }
  return rows;
}

/**
 * Start (once) a low-frequency dump of tracker state via the production logger.
 * Cheap and unref'd; only active when the feature flag is on.
 */
export function startAdaptiveObserver(log, intervalMs = 5 * 60 * 1000) {
  if (observerTimer || !ADAPTIVE_CONNECT_TIMEOUT) return;
  observerTimer = setInterval(() => {
    const rows = getTrackerSummary();
    if (rows.length) log.info("ADAPTIVE_TIMEOUT", `summary ${JSON.stringify(rows)}`);
  }, intervalMs);
  if (typeof observerTimer.unref === "function") observerTimer.unref();
}

/** Test / config-change seam: drop all latency windows. */
export function resetConnectTimeoutTracker() {
  samplesByProvider.clear();
  evictionsByProvider.clear();
}
