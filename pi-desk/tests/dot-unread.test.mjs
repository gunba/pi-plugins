import assert from "node:assert/strict";
import test from "node:test";
import { dotReadKey, markDotRead, mergeDotReadStates, readDotReadState, unreadDotMessages } from "../src/client/dot-unread.ts";
const message = (id, author = "dot", minute = Number(id)) => ({ id, author, created: `2026-10-06T12:${String(minute).padStart(2, "0")}:00Z`, text: "Message", attachments: [] });

test("first load baselines history, then new Dot messages stay unread until acknowledged", () => {
 const history = [message("1"), message("2", "owner")], state = readDotReadState(null, history);
 assert.equal(unreadDotMessages(state, history).length, 0);
 const current = [...history, message("3"), message("4", "owner"), message("5")];
 assert.deepEqual(unreadDotMessages(state, current).map(item => item.id), ["3", "5"]);
 assert.deepEqual(unreadDotMessages(readDotReadState(JSON.stringify(state), current), current).map(item => item.id), ["3", "5"], "reload is not acknowledgement");
 const read = markDotRead(state, current);
 assert.equal(unreadDotMessages(read, current).length, 0);
 assert.equal(markDotRead(read, history), read, "older pages cannot regress the read position");
 assert.equal(unreadDotMessages(read, [{ ...message("5"), text: "Edited" }]).length, 0, "message edits are not new arrivals");
 assert.deepEqual(state, { version: 1, through: { ids: ["1"], created: history[0].created } }, "no message bodies persist in read state");
});
test("new IDs sharing the read timestamp are unread regardless of their sort order", () => {
 const first = message("z", "dot", 1), next = message("a", "dot", 1);
 const state = readDotReadState(null, [first]);
 assert.deepEqual(unreadDotMessages(state, [next, first]).map(item => item.id), ["a"]);
 const read = markDotRead(state, [next, first]);
 assert.equal(unreadDotMessages(read, [first, next]).length, 0);
 assert.equal(markDotRead(read, [first]), read, "a narrow snapshot cannot forget already-read IDs");
});
test("read markers merge monotonically across tabs and converge for timestamp ties", () => {
 const old = readDotReadState(null, [message("1")]);
 const current = markDotRead(old, [message("2")]);
 assert.equal(mergeDotReadStates(current, old), current, "late storage updates cannot regress a cursor");
 const a = readDotReadState(null, [message("a", "dot", 1)]), z = readDotReadState(null, [message("z", "dot", 1)]);
 assert.deepEqual(mergeDotReadStates(a, z), mergeDotReadStates(z, a), "both tabs write the same marker");
 assert.equal(unreadDotMessages(mergeDotReadStates(a, z), [message("a", "dot", 1), message("z", "dot", 1)]).length, 0);
 assert.equal(mergeDotReadStates(current, readDotReadState("invalid", [])), current);
});
test("empty baseline detects the first incoming message and account bindings do not share read markers", () => {
 const empty = readDotReadState(null, []);
 assert.equal(unreadDotMessages(empty, [message("1", "owner")]).length, 0);
 assert.equal(unreadDotMessages(readDotReadState(JSON.stringify(empty), []), [message("1")]).length, 1);
 assert.notEqual(dotReadKey("pc", "account-one"), dotReadKey("pc", "account-two"));
 assert.notEqual(dotReadKey("pc", "binding"), dotReadKey("other-pc", "binding"));
 assert.deepEqual(readDotReadState("invalid", [message("1")]), readDotReadState(null, [message("1")]));
});
