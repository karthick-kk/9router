/**
 * kiroStreamLive per-connection opt-out of the Kiro integrity gate.
 *
 * The integrity gate (attachIntegrityGate) buffers the ENTIRE upstream
 * EventStream before releasing it, so it can detect + auto-retry truncated /
 * corrupt turns. That buffering is what makes a `-thinking` model's
 * reasoning_content deltas arrive in one burst at the end instead of streaming
 * live. The live path (providerSpecificData.kiroStreamLive === true) skips the
 * gate and converts the EventStream to SSE as it arrives via
 * transformEventStreamToSSE, giving up only the truncation RETRY.
 *
 * Observable difference pinned here: the gated path's first byte is the
 * `: kiro-validation` heartbeat (content held until clean EOF); the live path
 * never emits that heartbeat and releases the first delta before the stream
 * closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");

const encoder = new TextEncoder();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeHeader(name, value) {
  const nameBytes = encoder.encode(name);
  const valueBytes = encoder.encode(value);
  const bytes = new Uint8Array(1 + nameBytes.length + 3 + valueBytes.length);
  let offset = 0;
  bytes[offset++] = nameBytes.length;
  bytes.set(nameBytes, offset);
  offset += nameBytes.length;
  bytes[offset++] = 7;
  new DataView(bytes.buffer).setUint16(offset, valueBytes.length, false);
  offset += 2;
  bytes.set(valueBytes, offset);
  return bytes;
}

function checksum(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(8, crc32(bytes.subarray(0, 8)), false);
  view.setUint32(bytes.byteLength - 4, crc32(bytes.subarray(0, bytes.byteLength - 4)), false);
  return bytes;
}

function frame(eventType, payload) {
  const headers = encodeHeader(":event-type", eventType);
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const totalLength = 12 + headers.byteLength + payloadBytes.byteLength + 4;
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headers.byteLength, false);
  out.set(headers, 12);
  out.set(payloadBytes, 12 + headers.byteLength);
  return checksum(out);
}

/**
 * A controlled upstream response: enqueue the given frames on start, but keep
 * the controller open so the caller can enqueue more / close on demand. This
 * lets the live test enqueue the first reasoning frame, then verify a delta was
 * already emitted BEFORE the stream is closed.
 */
function controlledResponse(frames = []) {
  let controller;
  const value = new Response(new ReadableStream({
    start(streamController) {
      controller = streamController;
      for (const item of frames) controller.enqueue(item);
    },
  }), { status: 200 });
  return {
    value,
    enqueue(item) { controller.enqueue(item); },
    close() { controller.close(); },
  };
}

async function execute(executor = new KiroExecutor(), credentialsOverride = {}) {
  return executor.execute({
    model: "krb/claude-haiku-5.5-thinking",
    body: { conversationState: { currentMessage: { userInputMessage: { content: "base", modelId: "m" } } } },
    stream: true,
    credentials: {
      accessToken: "test-token",
      providerSpecificData: { region: "us-east-1", ...credentialsOverride },
    },
  });
}

async function readUntil(reader, predicate, maxFrames = 100) {
  const decoder = new TextDecoder();
  let output = "";
  for (let i = 0; i < maxFrames; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    if (predicate(output)) return output;
  }
  return output;
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("kiroStreamLive integrity-gate opt-out", () => {
  it("DEFAULT (flag off): holds content behind a kiro-validation heartbeat (gated)", async () => {
    const upstream = controlledResponse([frame("assistantResponseEvent", { content: "answer" })]);
    fetchMock.mockResolvedValueOnce(upstream.value);

    const result = await execute(new KiroExecutor());
    const reader = result.response.body.getReader();
    const decoder = new TextDecoder();

    // First byte is the gate's heartbeat, NOT the content.
    const { value } = await reader.read();
    expect(decoder.decode(value)).toBe(": kiro-validation\n\n");

    // Release the upstream; the gated path only emits the real SSE once the
    // whole stream is validated at clean EOF.
    upstream.close();
    const rest = await readUntil(reader, (o) => o.includes("[DONE]"));
    expect(rest).toContain("\"content\":\"answer\"");
    await reader.cancel?.().catch(() => {});
  });

  it("LIVE (flag on): emits the first delta before the stream closes, no heartbeat", async () => {
    const upstream = controlledResponse([
      frame("reasoningContentEvent", { text: "thinking..." }),
      frame("assistantResponseEvent", { content: "answer" }),
    ]);
    fetchMock.mockResolvedValueOnce(upstream.value);

    const result = await execute(new KiroExecutor(), { kiroStreamLive: true });
    const reader = result.response.body.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let sawHeartbeat = false;

    // Read what's already available WITHOUT closing the upstream. In live mode
    // the first reasoning delta must be flushed as it arrives, so this must
    // return real content before close() is called.
    const first = await reader.read();
    output += decoder.decode(first.value, { stream: true });
    sawHeartbeat = sawHeartbeat || first.value.includes(": kiro-validation");

    expect(sawHeartbeat).toBe(false);
    expect(output).toContain("\"reasoning_content\":\"thinking...\"");
    expect(output).not.toContain("[DONE]");

    // Now close the upstream and drain to the finish frame.
    upstream.close();
    const rest = await readUntil(reader, (o) => o.includes("[DONE]"));
    expect(output + rest).toContain("\"finish_reason\":\"stop\"");
    expect(output + rest).toContain("[DONE]");
    await reader.cancel?.().catch(() => {});
  });

  it("LIVE (flag on): honors the client abort signal and tears down the upstream", async () => {
    const upstream = controlledResponse([frame("reasoningContentEvent", { text: "partial" })]);
    fetchMock.mockResolvedValueOnce(upstream.value);

    const abort = new AbortController();
    const result = await (async () => {
      const executor = new KiroExecutor();
      return executor.execute({
        model: "krb/claude-haiku-5.5-thinking",
        body: { conversationState: { currentMessage: { userInputMessage: { content: "base", modelId: "m" } } } },
        stream: true,
        credentials: { accessToken: "t", providerSpecificData: { kiroStreamLive: true } },
        signal: abort.signal,
      });
    })();

    const reader = result.response.body.getReader();
    // Consume the first emitted frame, then abort mid-stream.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("partial");
    abort.abort();

    // The transform's start loop observes the abort and closes the stream (the
    // client no longer gets a [DONE] finish frame).
    let sawDone = false;
    let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      const { value, done: d } = await reader.read();
      if (d) { done = true; break; }
      if (new TextDecoder().decode(value).includes("[DONE]")) sawDone = true;
    }
    expect(done).toBe(true);
    expect(sawDone).toBe(false);
  });

  it("LIVE (flag on): a falsy/absent flag value still routes to the gated path", async () => {
    // kiroStreamLive: false / "true" (string) / 0 must all fall through to the
    // gate — only the strict boolean true opts in.
    for (const value of [false, "true", 0]) {
      const upstream = controlledResponse([frame("assistantResponseEvent", { content: "x" })]);
      fetchMock.mockResolvedValueOnce(upstream.value);
      const result = await execute(new KiroExecutor(), { kiroStreamLive: value });
      const reader = result.response.body.getReader();
      const { value: first } = await reader.read();
      expect(new TextDecoder().decode(first)).toBe(": kiro-validation\n\n");
      upstream.close();
      await readUntil(reader, (o) => o.includes("[DONE]"));
      await reader.cancel?.().catch(() => {});
    }
  });
});
