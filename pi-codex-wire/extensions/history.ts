/**
 * Native Codex 0.164.0 history metadata for Pi's serialized input: item IDs, field order and the
 * `internal_chat_message_metadata_passthrough` each item carries (turn, creation time, content kinds and provenance).
 * Checked against requests the official binary sent. Native IDs are time-ordered UUIDv7s minted when an item is
 * created; here the time comes from Pi's message timestamps and the remaining bits from a hash, so every request
 * describes the same item identically (continuation and prompt caching compare them).
 */
import { createHash } from "node:crypto";

type ObjectValue = Record<string, unknown>;
const record = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};

/** A UUIDv7 for `ms` whose other bits come from `seed`: the same inputs always give the same ID. */
export function uuid7(ms: number, seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  const time = BigInt(Math.max(0, Math.floor(ms)));
  for (let i = 0; i < 6; i++) bytes[i] = Number((time >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface Turn { id: string; started: number }
/** What the serialized items cannot say: when each of Pi's messages was written, and which turn it belongs to. */
export interface ItemHistory {
  /** Pi's user messages that serialize to an input item, in order. */
  users: { at: number; turn: Turn }[];
  /** Tool results by call ID. */
  outputs: Map<string, { at: number; turn: Turn }>;
  first?: Turn;
  current?: Turn;
}

type PiMessage = { role?: string; timestamp?: number; content?: unknown; toolCallId?: string };
const hasContent = (message: PiMessage) => typeof message.content === "string" || Array.isArray(message.content) && message.content.length > 0;

/**
 * Turns from Pi's messages: a user message after an assistant reply (or at the start) begins one; a user message that
 * follows a tool result or another user message (steering, queued notices) joins the turn in progress.
 */
export function itemHistory(messages: readonly unknown[], threadId: string): ItemHistory {
  const history: ItemHistory = { users: [], outputs: new Map() };
  let previous: string | undefined;
  for (const value of messages) {
    const message = value as PiMessage;
    const at = typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : 0;
    if (message.role === "user" && hasContent(message)) {
      if (!history.current || previous === undefined || previous === "assistant") {
        history.current = { id: uuid7(at, `${threadId}:turn:${at}`), started: at };
        history.first ??= history.current;
      }
      history.users.push({ at, turn: history.current });
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string" && history.current) {
      history.outputs.set(message.toolCallId.split("|")[0]!, { at, turn: history.current });
    }
    if (message.role) previous = message.role;
  }
  return history;
}

const KINDS: Record<string, string> = { input_text: "user.text", input_image: "user.image" };
/** The fields of a native item in its declaration order, then anything else Pi sent. */
function ordered(item: ObjectValue, keys: string[], extra: ObjectValue): ObjectValue {
  const result: ObjectValue = {};
  for (const key of keys) if (Object.hasOwn(extra, key)) { if (extra[key] !== undefined) result[key] = extra[key]; }
    else if (item[key] !== undefined) result[key] = item[key];
  for (const [key, value] of Object.entries(item)) if (!Object.hasOwn(result, key) && value !== undefined && key !== "internal_chat_message_metadata_passthrough") result[key] = value;
  return result;
}
const seconds = (ms: number) => Math.round(ms) / 1000;

/**
 * The input items with native IDs, field order and passthrough metadata. Items the history does not place keep the
 * turn in progress (`turn`, for a reply's own items replayed before the next request).
 */
export function annotateItems(input: readonly unknown[], options: { threadId: string; lite: boolean; history: ItemHistory; turn?: Turn }): ObjectValue[] {
  const { threadId, lite, history } = options;
  let users = 0, turn = options.turn;
  return input.map(value => {
    const item = record(value);
    const type = item.type ?? (typeof item.role === "string" ? "message" : undefined);
    if (type === "message" && item.role === "user") {
      const placed = history.users[users++];
      if (placed) turn = placed.turn;
      const at = placed?.at ?? turn?.started ?? 0;
      const content = Array.isArray(item.content) ? item.content : [{ type: "input_text", text: String(item.content ?? "") }];
      return ordered(item, ["type", "id", "role", "content", "internal_chat_message_metadata_passthrough"], {
        type: "message", id: typeof item.id === "string" ? item.id : `msg_${uuid7(at, `${threadId}:user:${at}:${users}`)}`, content,
        internal_chat_message_metadata_passthrough: { ...(turn ? { turn_id: turn.id } : {}), create_time: seconds(at),
          content_item_kinds: content.map(part => KINDS[String(record(part).type)] ?? "user.text"),
          ...(lite ? { content_item_metadata: content.map(() => ({ provenance: { type: "user" } })) } : {}) },
      });
    }
    const pass = (extra: ObjectValue = {}) => ({ internal_chat_message_metadata_passthrough: { ...(turn ? { turn_id: turn.id } : {}), ...extra } });
    if (type === "message" && item.role === "assistant") {
      const content = Array.isArray(item.content) ? item.content : [];
      return ordered(item, ["type", "status", "id", "role", "content", "phase", "internal_chat_message_metadata_passthrough"],
        { type: "message", status: item.status ?? "completed", ...pass({ content_item_kinds: content.map(() => "unknown") }) });
    }
    if (type === "message") {
      // Pi's own mid-conversation system and developer messages (instruction updates, tool notices).
      const at = turn?.started ?? 0;
      const content = Array.isArray(item.content) ? item.content : [{ type: "input_text", text: String(item.content ?? "") }];
      return ordered(item, ["type", "id", "role", "content", "internal_chat_message_metadata_passthrough"], {
        type: "message", id: typeof item.id === "string" ? item.id : `msg_${uuid7(at, `${threadId}:${String(item.role)}:${JSON.stringify(content)}`)}`, content,
        ...pass({ create_time: seconds(at), content_item_kinds: content.map(() => "generic"),
          ...(lite ? { content_item_metadata: content.map(() => ({ provenance: { type: "harness", hook: false } })) } : {}) }),
      });
    }
    if (type === "reasoning") {
      return ordered(item, ["type", "id", "summary", "content", "encrypted_content", "internal_chat_message_metadata_passthrough"],
        { content: item.content ?? null, ...pass() });
    }
    if (type === "function_call") {
      return ordered(item, ["type", "status", "id", "name", "namespace", "arguments", "call_id", "internal_chat_message_metadata_passthrough"],
        { status: item.status ?? "completed", ...pass() });
    }
    if (type === "custom_tool_call") {
      return ordered(item, ["type", "id", "status", "call_id", "name", "namespace", "input", "internal_chat_message_metadata_passthrough"],
        { status: item.status ?? "completed", ...pass() });
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const placed = history.outputs.get(String(item.call_id));
      if (placed) turn = placed.turn;
      const at = placed?.at ?? turn?.started ?? 0, prefix = type === "function_call_output" ? "fco" : "ctco";
      return ordered(item, ["type", "id", "call_id", "name", "namespace", "output", "internal_chat_message_metadata_passthrough"], {
        id: typeof item.id === "string" ? item.id : `${prefix}_${uuid7(at, `${threadId}:${prefix}:${String(item.call_id)}`)}`,
        ...pass({ create_time: seconds(at) }),
      });
    }
    if (type === "additional_tools" && lite) {
      // A later tool load, recorded in history as native tool batches are.
      const at = turn?.started ?? 0;
      return ordered(item, ["type", "id", "role", "tools"],
        { id: typeof item.id === "string" ? item.id : `at_${uuid7(at, `${threadId}:at:${JSON.stringify(item.tools)}`)}` });
    }
    return item;
  });
}
