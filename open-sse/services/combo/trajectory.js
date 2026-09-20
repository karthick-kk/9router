/**
 * Read-only inspection of a request body's conversation, shared by the classifier
 * and the stage scorer.
 *
 * Everything here works on the *client* format (the body as it arrived, before
 * translation), so it must handle OpenAI chat, Claude messages, the Responses API
 * and Gemini `contents` alike. Nothing in this file mutates the body.
 */

import { ROLE, GEMINI_ROLE } from "../../translator/schema/roles.js";
import { CLAUDE_BLOCK, OPENAI_BLOCK, RESPONSES_ITEM } from "../../translator/schema/blocks.js";

const ASSISTANT_ROLES = new Set([ROLE.ASSISTANT, GEMINI_ROLE.MODEL]);

/**
 * Return the conversation turns plus which array they came from, so callers can
 * stay format-agnostic. Gemini turns carry `parts` instead of `content`.
 * @param {object} body
 * @returns {{ items: object[], shape: "messages"|"input"|"contents"|"none" }}
 */
export function conversationItems(body) {
  if (Array.isArray(body?.messages)) return { items: body.messages, shape: "messages" };
  if (Array.isArray(body?.input)) return { items: body.input, shape: "input" };
  const contents = body?.contents || body?.request?.contents;
  if (Array.isArray(contents)) return { items: contents, shape: "contents" };
  return { items: [], shape: "none" };
}

/** Flatten any of the supported content shapes to plain text. */
export function itemText(item) {
  if (!item || typeof item !== "object") return "";
  const parts = [];
  const push = (v) => { if (typeof v === "string" && v) parts.push(v); };

  push(typeof item.content === "string" ? item.content : "");

  const blocks = Array.isArray(item.content) ? item.content : Array.isArray(item.parts) ? item.parts : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      if (typeof block === "string") push(block);
      continue;
    }
    // Gemini parts have no type discriminator, just `.text`.
    if (block.type === undefined) { push(block.text); continue; }
    if (block.type === OPENAI_BLOCK.TEXT || block.type === RESPONSES_ITEM.INPUT_TEXT || block.type === RESPONSES_ITEM.OUTPUT_TEXT) push(block.text);
  }
  return parts.join("\n");
}

/** True when this turn is the assistant/model side of the conversation. */
export function isAssistantItem(item) {
  return ASSISTANT_ROLES.has(item?.role);
}

/**
 * True when the turn is a tool result rather than something a human typed.
 * Tool results reach us as OpenAI `role:"tool"`, Claude `tool_result` blocks
 * inside a user turn, or Responses `function_call_output` items — all three wear
 * a user-ish role, which is exactly the ambiguity the classifier must avoid.
 */
export function isToolResultItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.role === ROLE.TOOL || item.role === "function") return true;
  if (item.type === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT || item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT) return true;
  const blocks = Array.isArray(item.content) ? item.content : Array.isArray(item.parts) ? item.parts : [];
  if (blocks.length === 0) return false;
  const hasToolResult = blocks.some((b) => b?.type === CLAUDE_BLOCK.TOOL_RESULT || b?.functionResponse);
  if (!hasToolResult) return false;
  // A turn mixing a tool result with typed prose still counts as a tool continuation:
  // agents append tool output to the same user turn, they don't ask a new question there.
  return true;
}

/** Names of the tools the assistant invoked in this turn. */
export function toolCallNames(item) {
  if (!item || typeof item !== "object") return [];
  const names = [];
  if (Array.isArray(item.tool_calls)) {
    for (const call of item.tool_calls) {
      const name = call?.function?.name || call?.name;
      if (name) names.push(String(name));
    }
  }
  if (item.type === RESPONSES_ITEM.FUNCTION_CALL && item.name) names.push(String(item.name));
  const blocks = Array.isArray(item.content) ? item.content : Array.isArray(item.parts) ? item.parts : [];
  for (const block of blocks) {
    if (block?.type === CLAUDE_BLOCK.TOOL_USE && block.name) names.push(String(block.name));
    if (block?.functionCall?.name) names.push(String(block.functionCall.name));
  }
  return names;
}

/** Text of every tool result in a turn, plus whether the provider flagged an error. */
export function toolResultEntries(item) {
  if (!isToolResultItem(item)) return [];
  const out = [];
  if (item.role === ROLE.TOOL || item.role === "function") {
    out.push({ text: itemText(item) || stringifyLoose(item.content), isError: false });
  }
  if (item.type === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT || item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT) {
    out.push({ text: stringifyLoose(item.output ?? item.content), isError: false });
  }
  const blocks = Array.isArray(item.content) ? item.content : Array.isArray(item.parts) ? item.parts : [];
  for (const block of blocks) {
    if (block?.type === CLAUDE_BLOCK.TOOL_RESULT) {
      out.push({ text: stringifyLoose(block.content), isError: block.is_error === true });
    }
    if (block?.functionResponse) {
      out.push({ text: stringifyLoose(block.functionResponse.response), isError: false });
    }
  }
  return out;
}

// Best-effort text for content that may be a string, block array, or arbitrary object.
function stringifyLoose(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "string" ? v : v?.text || stringifyLoose(v?.content) || "")).join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

/**
 * The trailing run of items after the last assistant turn, i.e. whatever the
 * client added since the model last spoke.
 */
export function trailingTurn(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  let i = items.length - 1;
  while (i >= 0 && !isAssistantItem(items[i])) i--;
  return items.slice(i + 1);
}

/**
 * Classify the trailing turn: a human-typed request (`user`), a tool-loop
 * continuation (`tool`), or nothing actionable (`none`).
 *
 * This is what gates the classifier — it must fire on new user turns only.
 * @param {object} body
 * @returns {{ kind: "user"|"tool"|"none", text: string }}
 */
export function classifyTrailingTurn(body) {
  const { items } = conversationItems(body);
  const trailing = trailingTurn(items);
  if (trailing.length === 0) return { kind: "none", text: "" };

  // Any tool result in the trailing run means the agent is mid-loop.
  if (trailing.some(isToolResultItem)) return { kind: "tool", text: "" };

  const text = trailing.map(itemText).filter(Boolean).join("\n").trim();
  if (!text) return { kind: "none", text: "" };
  return { kind: "user", text };
}
