import { KiroExecutor } from "./kiro.js";
import { PROVIDERS } from "../config/providers.js";
import { KIRO_CODEWHISPERER_TARGET } from "../config/kiroConstants.js";
import { v4 as uuidv4 } from "uuid";
import {
  resolveKiroCliApiRegion,
  resolveKiroCliProfileArn,
} from "../services/kiroCliModels.js";

/**
 * KiroCliExecutor - Kiro provider via the Kiro agent gateway
 * (`runtime.{apiRegion}.kiro.dev` + `management.{apiRegion}.kiro.dev`).
 *
 * Reuses the full `kiro` format, translators, and the AWS EventStream parser
 * from {@link KiroExecutor}. It differs only in the transport surface:
 *
 *   - Inference goes to `runtime.{apiRegion}.kiro.dev/generateAssistantResponse`
 *     (the same gateway the pi-provider-kiro extension and the official
 *     `kiro-cli` tool use), instead of the `codewhisperer.*.amazonaws.com`
 *     surface that the legacy `kiro` provider uses.
 *   - ProfileArn is resolved over the gateway management API across
 *     `[apiRegion, us-east-1, eu-central-1]`, so accounts whose profile lives in
 *     a non-default region (e.g. eu-central-1) resolve correctly — the legacy
 *     surface only probes us-east-1 and returns an empty list for them.
 *   - The gateway is not the raw CodeWhisperer JSON-1.0 API, so we do NOT send
 *     `TokenType: API_KEY` (which the gateway rejects) and we add the gateway
 *     headers (`x-amzn-kiro-agent-mode`, `x-amzn-codewhisperer-optout`, and the
 *     rust-style User-Agent) that the Kiro CLI clients send.
 */
export class KiroCliExecutor extends KiroExecutor {
  constructor() {
    super();
    this.provider = "kiro-cli";
    this.config = PROVIDERS["kiro-cli"];
  }

  /**
   * The gateway runtime endpoint lives in the Kiro API region for this account,
   * not the SSO login region and not always us-east-1.
   */
  getOrderedBaseUrls(credentials) {
    const ssoRegion = credentials?.providerSpecificData?.region || "us-east-1";
    const apiRegion = resolveKiroCliApiRegion(ssoRegion);
    return [`https://runtime.${apiRegion}.kiro.dev/generateAssistantResponse`];
  }

  buildHeaders(credentials, stream = true, url = "") {
    const headers = {
      ...(this.config?.headers || {}),
      "Content-Type": "application/json",
      Accept: "application/vnd.amazon.eventstream",
      "amz-sdk-request": "attempt=1; max=1",
      "amz-sdk-invocation-id": uuidv4(),
      // The gateway (unlike raw CodeWhisperer) expects these headers; do not send
      // TokenType (the gateway rejects TokenType: API_KEY).
      "x-amzn-kiro-agent-mode": "vibe",
      "x-amzn-codewhisperer-optout": "true",
    };

    const mid = uuidv4().replace(/-/g, "");
    const ua =
      `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 ` +
      `m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;
    headers["user-agent"] = ua;
    headers["x-amz-user-agent"] = ua;

    if (credentials?.accessToken) {
      headers["Authorization"] = `Bearer ${credentials.accessToken}`;
    }

    if (url.includes("://codewhisperer.")) {
      headers["X-Amz-Target"] = KIRO_CODEWHISPERER_TARGET;
    } else {
      delete headers["X-Amz-Target"];
    }

    return headers;
  }

  /**
   * The shared `claude-to-kiro` / `openai-to-kiro` translators emit
   * `origin: "AI_EDITOR"`. The gateway accepts both, but the Kiro CLI surface
   * is built for `origin: "KIRO_CLI"`. Rewrite it here so the shared translators
   * stay untouched, and ensure a resolved profileArn is present.
   */
  transformRequest(model, body, stream, credentials) {
    const next = structuredClone(body || {});
    const currentMessage = next.conversationState?.currentMessage;
    if (currentMessage?.userInputMessage) {
      currentMessage.userInputMessage.origin = "KIRO_CLI";
    }
    // Ensure a profileArn is present. For idc/api_key accounts the shared
    // translator deliberately omits the shared default ARN (it belongs to
    // another account). Resolve the account's own ARN now.
    if (credentials?.providerSpecificData?.profileArn) {
      next.profileArn = credentials.providerSpecificData.profileArn;
    }
    // The Kiro gateway rejects the top-level `systemPrompt` field with
    // 400 REQUEST_BODY_INVALID (unlike the legacy CodeWhisperer surface). The
    // shared openai-to-kiro translator already bakes the same prompt into the
    // user-message content via contentPrefix, so it is safe to drop the field.
    // Thinking (`additionalModelRequestFields`) is accepted and kept.
    delete next.systemPrompt;
    return next;
  }

  /**
   * Refresh via SSO OIDC (reuses the working refreshKiroToken path), then
   * re-resolve the gateway profileArn so a stale/absent profile is patched.
   */
  async refreshCredentials(credentials, log, proxyOptions = null) {
    const base = await super.refreshCredentials(credentials, log, proxyOptions);
    if (!base?.accessToken) return base;
    const psd = credentials?.providerSpecificData || {};
    let profileArn = base.providerSpecificData?.profileArn || psd.profileArn;
    if (!profileArn) {
      profileArn = await resolveKiroCliProfileArn(base.accessToken, psd.region, { log });
    }
    return {
      ...base,
      providerSpecificData: {
        ...(base.providerSpecificData || {}),
        ...(profileArn ? { profileArn } : {}),
      },
    };
  }
}

export default KiroCliExecutor;