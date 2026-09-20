/**
 * Kiro CLI gateway management API.
 *
 * The `kiro-cli` provider talks to the Kiro agent gateway
 * (`management.{apiRegion}.kiro.dev` + `runtime.{apiRegion}.kiro.dev`), NOT the
 * raw `codewhisperer.*.amazonaws.com` CodeWhisperer surface that the legacy
 * `kiro` provider uses.
 *
 * The gateway is the same one the pi-provider-kiro extension and the official
 * `kiro-cli` tool use. It differs from the legacy surface in two ways that matter
 * for our IDC accounts:
 *
 *   1. **API region is not always us-east-1.** The SSO region that mints the
 *      token (e.g. `eu-west-1`) maps to a Kiro API region (e.g. `eu-central-1`)
 *      via {@link resolveKiroCliApiRegion}. Profile and runtime endpoints live in
 *      the API region, not the login region.
 *   2. **The management API is region-agnostic service discovery.** We try
 *      `[apiRegion, us-east-1, eu-central-1]` for the profile, mirroring
 *      pi-provider-kiro. The legacy surface's hardcoded us-east-1 call returns an
 *      empty profile list for accounts whose profile lives elsewhere.
 *
 * Endpoint shapes (kebab-case paths, JSON):
 *   POST /List-Available-Profiles    body: {}            → { profiles: [{ arn }] }
 *   GET  /List-Available-Models?origin=KIRO_CLI&profileArn=… → { models: [...] }
 */

import { createHash } from "crypto";

/**
 * Map an AWS SSO (Identity Center) login region to the Kiro API region that
 * actually hosts this account's profile + runtime. Mirrors pi-provider-kiro's
 * API_REGION_MAP.
 */
export function resolveKiroCliApiRegion(ssoRegion) {
  if (!ssoRegion) return "us-east-1";
  return KIRO_CLI_API_REGION_MAP[ssoRegion] ?? ssoRegion;
}

/** SSO login region → Kiro API region. Regions not listed pass through. */
export const KIRO_CLI_API_REGION_MAP = {
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "us-east-2": "us-east-1",
  "ap-southeast-1": "us-east-1",
  "ap-southeast-2": "us-east-1",
  "ap-northeast-1": "us-east-1",
  "ap-south-1": "us-east-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
  "eu-south-2": "eu-central-1",
  "eu-central-2": "eu-central-1",
};

/** Regions probed for the management API, in order. */
const KIRO_CLI_MANAGEMENT_REGIONS = ["us-east-1", "eu-central-1"];

const KIRO_CLI_FETCH_TIMEOUT_MS = 15_000;

let profileArnCache = new Map();
let pendingProfileRequests = new Map();
let profileRegionCache = new Map();

/** Stable cache key per access token + region. */
function profileCacheKey(accessToken, region) {
  const tokenHash = createHash("sha256").update(accessToken || "").digest("base64url");
  return `${region}:${tokenHash}`;
}

function candidateManagementRegions(primary) {
  const seen = new Set([primary]);
  const candidates = [primary];
  for (const region of KIRO_CLI_MANAGEMENT_REGIONS) {
    if (!seen.has(region)) {
      seen.add(region);
      candidates.push(region);
    }
  }
  return candidates;
}

function managementUrl(region, path) {
  return `https://management.${region}.kiro.dev/${path}`;
}

async function requestManagement(accessToken, region, operation, path, method, body = {}, log) {
  const url = new URL(managementUrl(region, path));
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  let payload;
  if (method === "GET") {
    for (const [name, value] of Object.entries(body)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
  } else {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(KIRO_CLI_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Kiro CLI management ${operation} request failed in ${region}: ${err?.message || err}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Kiro CLI management ${operation} failed in ${region}: ${response.status} ${text}`.trim());
  }
  try {
    return await response.json();
  } catch (err) {
    throw new Error(`Kiro CLI management ${operation} returned invalid JSON in ${region}`);
  }
}

/**
 * Resolve the profileARN for a Kiro CLI account over the gateway management API.
 * Tries `[apiRegion, us-east-1, eu-central-1]` and returns the first non-empty
 * profile, mirroring pi-provider-kiro.
 *
 * @param {string} accessToken
 * @param {string} ssoRegion SSO login region used to derive the primary API region.
 * @param {object} [options]
 * @param {object} [options.log]
 * @returns {Promise<string|null>} profileArn or null when none can be resolved.
 */
export async function resolveKiroCliProfileArn(accessToken, ssoRegion, options = {}) {
  if (!accessToken) return null;
  const apiRegion = resolveKiroCliApiRegion(ssoRegion);
  const key = profileCacheKey(accessToken, apiRegion);
  const cached = profileArnCache.get(key);
  if (cached) return cached;
  const pending = pendingProfileRequests.get(key);
  if (pending) return pending;

  const request = (async () => {
    let lastError;
    for (const region of candidateManagementRegions(apiRegion)) {
      try {
        const data = await requestManagement(
          accessToken,
          region,
          "ListAvailableProfiles",
          "List-Available-Profiles",
          "POST",
          {},
          options.log,
        );
        const arn = (data?.profiles || []).find((p) => p?.arn)?.arn || null;
        if (arn) {
          profileArnCache.set(key, arn);
          profileRegionCache.set(key, region);
          options.log?.debug?.("KIRO_CLI", `resolved profileArn via ${region}`);
          return arn;
        }
      } catch (err) {
        lastError = err;
        // A 403 typically means this region is not the account's home — keep probing.
        options.log?.debug?.("KIRO_CLI", `profile probe in ${region} failed: ${err?.message || err}`);
      }
    }
    options.log?.warn?.("KIRO_CLI", `No profile resolved in ${candidateManagementRegions(apiRegion).join(", ")}: ${lastError?.message || "empty list"}`);
    return null;
  })();
  pendingProfileRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (pendingProfileRequests.get(key) === request) pendingProfileRequests.delete(key);
  }
}

/** Invalidate cached profile for a token after a re-login or refresh. */
export function invalidateKiroCliProfileArn(accessToken, ssoRegion) {
  const apiRegion = resolveKiroCliApiRegion(ssoRegion);
  const key = profileCacheKey(accessToken, apiRegion);
  profileArnCache.delete(key);
  profileRegionCache.delete(key);
}

/**
 * Resolve the profileArn for a Kiro CLI credential, preferring an already-stored
 * one. Mirrors pi-provider-kiro's resolve-in-order: stored → network.
 *
 * @param {object} providerSpecificData
 * @param {string} accessToken
 * @param {object} [options]
 * @returns {Promise<string|null>}
 */
export async function resolveKiroCliProfileArnForCredentials(credentials, options = {}) {
  const psd = credentials?.providerSpecificData || {};
  if (psd.profileArn) return psd.profileArn;
  const region = psd.region || DEFAULT_KIRO_CLI_REGION;
  const accessToken = credentials?.accessToken;
  if (!accessToken) return null;
  return resolveKiroCliProfileArn(accessToken, region, options);
}

const DEFAULT_KIRO_CLI_REGION = "us-east-1";

/**
 * Fetch the live model catalog for a Kiro CLI account over the gateway
 * management API.
 *
 * @param {string} accessToken
 * @param {string} profileArn
 * @param {string} ssoRegion
 * @param {object} [options]
 * @returns {Promise<object[]>} array of model entries `{ modelId, modelName, rateMultiplier, ... }`.
 * @throws {Error} on network/HTTP failure or empty catalog.
 */
export async function fetchKiroCliCatalog(accessToken, profileArn, ssoRegion, options = {}) {
  const apiRegion = resolveKiroCliApiRegion(ssoRegion);
  const data = await requestManagement(
    accessToken,
    apiRegion,
    "ListAvailableModels",
    "List-Available-Models",
    "GET",
    { origin: "KIRO_CLI", profileArn },
    options.log,
  );
  const models = Array.isArray(data?.models) ? data.models : [];
  if (models.length === 0) {
    throw new Error("Kiro CLI returned no available models");
  }
  return models;
}

/** Map a raw gateway model entry to the 9router model shape. */
export function normalizeKiroCliModel(raw) {
  return {
    id: raw.modelId,
    name: raw.modelName || raw.modelId,
    rateMultiplier: raw.rateMultiplier,
    contextWindow: raw.tokenLimits?.maxInputTokens || undefined,
  };
}