/**
 * Per-conversation routing state for the composite-stage combo strategy.
 *
 * An agentic tool loop is many separate HTTP/SSE requests, so the tier chosen on
 * the user turn has to outlive a single request. State lives in a module-level Map
 * keyed by combo + session id (same shape as comboRotationState in ../combo.js) and
 * is evicted on a TTL sweep so long-running instances don't grow unbounded.
 */

import crypto from "crypto";
import { MEMORY_CONFIG } from "../../config/runtimeConfig.js";

export const TIER = {
  CAPABLE: "capable",
  EFFICIENT: "efficient",
};

export const CLASSIFICATION_UNKNOWN = "unknown";

// Safety cap between sweeps, matching sessionManager's MAX_SESSIONS approach.
const MAX_ROUTING_SESSIONS = 5000;

/** @type {Map<string, { state: object, lastUsed: number }>} */
const routingStore = new Map();

function stateKey(comboName, sessionId) {
  return `${comboName || "__default__"}:${sessionId || "__nosession__"}`;
}

function freshState(sessionId) {
  return {
    sessionId: sessionId || null,
    currentTier: TIER.CAPABLE,
    initialClassification: CLASSIFICATION_UNKNOWN,
    lastStageScore: 0,
    lastClassifierDecision: null,
    classifierTimestamp: null,
    lastUserTurnFingerprint: null,
    turnCounter: 0,
    escalations: 0,
    downgrades: 0,
  };
}

/**
 * Read (or lazily create) the routing state for a conversation.
 * The returned object is the live record — mutate it, then call `touchRoutingState`
 * so the TTL sweep sees the access.
 *
 * @param {string} comboName
 * @param {string} sessionId
 * @returns {object} routing state
 */
export function getRoutingState(comboName, sessionId) {
  const key = stateKey(comboName, sessionId);
  const existing = routingStore.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.state;
  }

  if (routingStore.size >= MAX_ROUTING_SESSIONS) {
    routingStore.delete(routingStore.keys().next().value);
  }

  const state = freshState(sessionId);
  routingStore.set(key, { state, lastUsed: Date.now() });
  return state;
}

/** Mark a state as freshly used so the TTL sweep keeps it. */
export function touchRoutingState(comboName, sessionId) {
  const entry = routingStore.get(stateKey(comboName, sessionId));
  if (entry) entry.lastUsed = Date.now();
}

/**
 * Drop routing state. Called when combo settings change (strategy edits must not
 * leave a conversation pinned to a tier chosen under the old configuration).
 * @param {string} [comboName] - Combo to reset; omit to clear everything.
 */
export function resetRoutingState(comboName) {
  if (!comboName) {
    routingStore.clear();
    return;
  }
  const prefix = `${comboName}:`;
  for (const key of routingStore.keys()) {
    if (key.startsWith(prefix)) routingStore.delete(key);
  }
}

/** Stable short hash of a user turn, used to detect "same turn, retried". */
export function fingerprintTurn(text) {
  if (typeof text !== "string" || !text) return null;
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of routingStore) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) routingStore.delete(key);
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (sweep.unref) sweep.unref();
