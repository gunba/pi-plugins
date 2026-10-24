import assert from "node:assert/strict";
import test from "node:test";
import { annotateItems, itemHistory, uuid7 } from "../extensions/history.ts";

const thread = "01a16dcc-d55a-70a0-9160-2cbe8b126d1c";
// Pi's messages for two turns: a tool call with a steering message during it, then a second prompt.
const messages = [
  { role: "user", content: "pause briefly then say done", timestamp: 1_792_843_502_958 },
  { role: "assistant", content: [], stopReason: "toolUse", timestamp: 1_792_843_502_970 },
  { role: "toolResult", toolCallId: "call_2|fc_2", content: [], timestamp: 1_792_843_502_979 },
  { role: "user", content: "also mention the time", timestamp: 1_792_843_502_990 },
  { role: "assistant", content: [], stopReason: "stop", timestamp: 1_792_843_503_100 },
  { role: "user", content: [{ type: "text", text: "and again" }, { type: "image", data: "", mimeType: "image/png" }], timestamp: 1_792_843_514_319 },
];
// The same items as Pi serializes them.
const input = [
  { role: "user", content: [{ type: "input_text", text: "pause briefly then say done" }] },
  { type: "reasoning", id: "rs_2", summary: [{ type: "summary_text", text: "**Checking**" }], encrypted_content: "ENC2" },
  { type: "function_call", id: "fc_2", call_id: "call_2", name: "sleep", arguments: "{}", namespace: "clock" },
  { type: "function_call_output", call_id: "call_2", output: "Sleep completed." },
  { role: "user", content: [{ type: "input_text", text: "also mention the time" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }], status: "completed", id: "msg_3" },
  { role: "user", content: [{ type: "input_text", text: "and again" }, { type: "input_image", image_url: "data:image/png;base64,", detail: "auto" }] },
];

test("items carry native Codex 0.164.0 IDs, field order and passthrough metadata", () => {
  const history = itemHistory(messages, thread);
  const items = annotateItems(input, { threadId: thread, lite: true, history });
  const [first, second] = [history.users[0].turn, history.users[2].turn];
  assert.equal(history.users[1].turn, first, "a message during a tool loop joins the turn in progress");
  assert.notEqual(second.id, first.id);
  assert.equal(history.current, second);
  assert.match(first.id, /^01a16dcc-d56e-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a UUIDv7 at the turn's start");
  // Field orders and passthrough keys as captured from the official binary.
  assert.deepEqual(items.map(item => Object.keys(item)), [
    ["type", "id", "role", "content", "internal_chat_message_metadata_passthrough"],
    ["type", "id", "summary", "content", "encrypted_content", "internal_chat_message_metadata_passthrough"],
    ["type", "status", "id", "name", "namespace", "arguments", "call_id", "internal_chat_message_metadata_passthrough"],
    ["type", "id", "call_id", "output", "internal_chat_message_metadata_passthrough"],
    ["type", "id", "role", "content", "internal_chat_message_metadata_passthrough"],
    ["type", "status", "id", "role", "content", "internal_chat_message_metadata_passthrough"],
    ["type", "id", "role", "content", "internal_chat_message_metadata_passthrough"],
  ]);
  const pass = items.map(item => item.internal_chat_message_metadata_passthrough);
  assert.deepEqual(pass[0], { turn_id: first.id, create_time: 1_792_843_502.958, content_item_kinds: ["user.text"],
    content_item_metadata: [{ provenance: { type: "user" } }] });
  assert.deepEqual(pass[1], { turn_id: first.id });
  assert.equal(items[1].content, null);
  assert.deepEqual(pass[3], { turn_id: first.id, create_time: 1_792_843_502.979 });
  assert.match(items[3].id, /^fco_01a16dcc-d583-7/, "a UUIDv7 at the tool result's time");
  assert.deepEqual(pass[5], { turn_id: first.id, content_item_kinds: ["unknown"] });
  assert.deepEqual(pass[6].content_item_kinds, ["user.text", "user.image"]);
  assert.equal(pass[6].turn_id, second.id);
  // The same request gives the same items, so continuation and prompt caching see them unchanged.
  assert.deepEqual(annotateItems(input, { threadId: thread, lite: true, history: itemHistory(messages, thread) }), items);
  // Standard models keep content kinds but not attribution, as native requests clear it.
  assert.equal(annotateItems(input, { threadId: thread, lite: false, history }).at(-1).internal_chat_message_metadata_passthrough.content_item_metadata, undefined);
  // A reply's items, shaped before the next request, belong to the turn in progress.
  assert.equal(annotateItems(input.slice(1, 3), { threadId: thread, lite: true, history, turn: second })[0].internal_chat_message_metadata_passthrough.turn_id, second.id);
});

test("UUIDv7 IDs put the time in the leading bits and are deterministic", () => {
  assert.equal(uuid7(0x01a16dccd56e, "seed"), uuid7(0x01a16dccd56e, "seed"));
  assert.notEqual(uuid7(0x01a16dccd56e, "seed"), uuid7(0x01a16dccd56e, "other"));
  assert.match(uuid7(0x01a16dccd56e, "seed"), /^01a16dcc-d56e-7[0-9a-f]{3}-[89ab]/);
});
