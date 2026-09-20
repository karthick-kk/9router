export default {
  id: "kiro-cli",
  priority: 10,
  alias: "krb",
  uiAlias: "krb",
  display: {
    name: "Kiro CLI",
    icon: "psychology_alt",
    color: "#FF8C4B",
    website: "https://kiro.dev",
    notice: {
      signupUrl: "https://kiro.dev",
    },
  },
  category: "free",
  transport: {
    baseUrl: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    baseUrls: [
      "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    ],
    format: "kiro",
    retry: {
      "429": 0,
    },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.amazon.eventstream",
      "User-Agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
      "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
    },
    tokenUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
    authUrl: "https://prod.us-east-1.auth.desktop.kiro.dev",
    usage: {
      cwHost: "https://codewhisperer.us-east-1.amazonaws.com",
      qHost: "https://q.us-east-1.amazonaws.com",
      limitsPath: "/getUsageLimits",
    },
  },
  models: [
    // Models served through the Kiro CLI gateway (management.{region}.kiro.dev).
    // Upstream catalog is resolved at runtime; this is the static fallback.
    // Claude models also expose the synthetic `-thinking` / `-agentic` /
    // `-thinking-agentic` variants (same upstream, thinking/agentic on at
    // request time). NOTE: thinking (`-thinking` / `-thinking-agentic`) only
    // applies to models at/above the reasoning boundary (opus/sonnet 4.6+);
    // the Kiro gateway rejects `additionalModelRequestFields` thinking for
    // legacy models (4.5 / 4 / haiku-4.5) with 400 REQUEST_BODY_INVALID, so
    // those expose base + agentic only. `auto` routes server-side and exposes
    // neither: the gateway catalog reports additionalModelRequestFieldsSchema
    // null for it and it ignores thinking fields.
    { id: "auto", name: "Auto" },
    // Claude
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-opus-5-thinking", name: "Claude Opus 5 (Thinking)" },
    { id: "claude-opus-5-agentic", name: "Claude Opus 5 (Agentic)" },
    { id: "claude-opus-5-thinking-agentic", name: "Claude Opus 5 (Thinking + Agentic)" },
    { id: "claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4.8-thinking", name: "Claude Opus 4.8 (Thinking)" },
    { id: "claude-opus-4.8-agentic", name: "Claude Opus 4.8 (Agentic)" },
    { id: "claude-opus-4.8-thinking-agentic", name: "Claude Opus 4.8 (Thinking + Agentic)" },
    { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4.7-thinking", name: "Claude Opus 4.7 (Thinking)" },
    { id: "claude-opus-4.7-agentic", name: "Claude Opus 4.7 (Agentic)" },
    { id: "claude-opus-4.7-thinking-agentic", name: "Claude Opus 4.7 (Thinking + Agentic)" },
    { id: "claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "claude-opus-4.6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { id: "claude-opus-4.6-agentic", name: "Claude Opus 4.6 (Agentic)" },
    { id: "claude-opus-4.6-thinking-agentic", name: "Claude Opus 4.6 (Thinking + Agentic)" },
    { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
    { id: "claude-opus-4.5-agentic", name: "Claude Opus 4.5 (Agentic)" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-sonnet-5-thinking", name: "Claude Sonnet 5 (Thinking)" },
    { id: "claude-sonnet-5-agentic", name: "Claude Sonnet 5 (Agentic)" },
    { id: "claude-sonnet-5-thinking-agentic", name: "Claude Sonnet 5 (Thinking + Agentic)" },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-4.6-thinking", name: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-sonnet-4.6-agentic", name: "Claude Sonnet 4.6 (Agentic)" },
    { id: "claude-sonnet-4.6-thinking-agentic", name: "Claude Sonnet 4.6 (Thinking + Agentic)" },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "claude-sonnet-4.5-agentic", name: "Claude Sonnet 4.5 (Agentic)" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
    { id: "claude-sonnet-4-agentic", name: "Claude Sonnet 4 (Agentic)" },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    { id: "claude-haiku-4.5-agentic", name: "Claude Haiku 4.5 (Agentic)" },
    // Non-Anthropic (no synthetic variants — mirroring legacy kiro)
    { id: "minimax-m2.5", name: "MiniMax M2.5" },
    { id: "minimax-m2.1", name: "MiniMax M2.1" },
    { id: "qwen3-coder-next", name: "Qwen3 Coder Next" },
  ],
  oauth: {
    ssoOidcEndpoint: "https://oidc.us-east-1.amazonaws.com",
    registerClientUrl: "https://oidc.us-east-1.amazonaws.com/client/register",
    deviceAuthUrl: "https://oidc.us-east-1.amazonaws.com/device_authorization",
    tokenUrl: "https://oidc.us-east-1.amazonaws.com/token",
    startUrl: "https://view.awsapps.com/start",
    clientName: "kiro-cli-oauth-client",
    clientType: "public",
    scopes: [
      "codewhisperer:completions",
      "codewhisperer:analysis",
      "codewhisperer:conversations",
      "codewhisperer:transformations",
      "codewhisperer:taskassist",
    ],
    grantTypes: [
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
    ],
    issuerUrl: "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
    socialAuthEndpoint: "https://prod.us-east-1.auth.desktop.kiro.dev",
    socialLoginUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/login",
    socialTokenUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token",
    socialRefreshUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
    authMethods: [
      "builder-id",
      "idc",
      "google",
      "github",
      "import",
    ],
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};