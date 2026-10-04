import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";
import { recordLatency, suggestTimeout, evictProvider, startAdaptiveObserver } from "../services/connect-timeout.js";

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses" ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, providerOverrides = null }) {
    // Lazily start the periodic latency-window dump once the feature is exercised
    // in production (idempotent; the observer no-ops unless ADAPTIVE_CONNECT_TIMEOUT).
    startAdaptiveObserver(log);
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    // response (optional) lets a subclass hook compute a dynamic delay (e.g. antigravity Retry-After).
    const tryRetry = async (urlIndex, statusKey, reason, response = null) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      // Hook: subclass may derive delay from the response (headers/body). null → skip retry, use fallback.
      let waitMs = delayMs;
      if (response && this.computeRetryDelay) {
        const dynamic = await this.computeRetryDelay(response, retryAttemptsByUrl[urlIndex] + 1, delayMs);
        if (dynamic === false) return false; // hook vetoes retry (e.g. Retry-After too long)
        if (dynamic != null) waitMs = dynamic;
      }
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${waitMs / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return true;
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      const headers = this.buildHeaders(credentials, stream, url, model, transformedBody);
      // User per-provider override wins over registry headers (blocked names filtered at the API)
      if (providerOverrides?.headers) Object.assign(headers, providerOverrides.headers);

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Abort if upstream doesn't return response headers within connection timeout.
      // Precedence: user per-provider override → adaptive suggestion (live p95,
      // tighten-only, opt-in) → registry default → global static.
      const connectCtrl = new AbortController();
      const timeoutMs = providerOverrides?.timeoutMs || suggestTimeout(this.provider) || this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectReason = new Error("fetch connect timeout");
      const connectTimer = setTimeout(() => connectCtrl.abort(connectReason), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${bodyStr.length}B | connectTimeout=${timeoutMs}ms`);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal
        }, proxyOptions);
        clearTimeout(connectTimer);
        const ttftMs = Date.now() - fetchT0;
        // Feed the adaptive timeout window with 2xx header-latency only: a 5xx
        // that answers fast (proxy alive, backend dead) must not tighten budgets.
        if (response.ok) recordLatency(this.provider, ttftMs);
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${ttftMs}ms | ct=${ct} | cl=${cl}`);

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`, response)) { urlIndex--; continue; }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        clearTimeout(connectTimer);
        lastError = error;
        // connectCtrl is only ever aborted by the connect timer, so its signal
        // is the authoritative "the connect phase timed out" flag. (Not
        // error.name === "AbortError": under undici the rejection is a plain
        // Error with message "fetch connect timeout", never name "AbortError".)
        const isConnectTimeout = connectCtrl.signal.aborted;
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        // A connect timeout means this provider's latency just changed (down, or
        // back-but-slower). Drop its adaptive window so stale "fast" samples can't
        // keep starving a recovering upstream under a budget it no longer meets.
        if (isConnectTimeout) evictProvider(this.provider);
        // A client-side cancel (caller's signal aborted) is not an upstream
        // failure — don't retry or 502, propagate it.
        if (!isConnectTimeout && mergedSignal.aborted) throw error;

        // A connect timeout must NOT take the timed 502 retry: the connect phase
        // didn't complete, so retrying the same URL 3s later will hit the same
        // hang and multiply the cost. A plain network error (ECONNREFUSED on a
        // proxy restart) can self-heal, so it keeps the 502 retry config.
        if (!isConnectTimeout && (await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, `network "${error.message}"`))) { urlIndex--; continue; }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
