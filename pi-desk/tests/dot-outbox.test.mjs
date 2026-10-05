import assert from "node:assert/strict";
import test from "node:test";
import { dotOutboxKey, dotReservedFiles, enqueueDot, nextDotInput, pendingDotMessages, readDotOutbox, reconcileDotInput } from "../src/client/dot-outbox.ts";
const file = { id: "file", dot: "dot", name: "example.txt", mime: "text/plain", size: 4, received: 4, state: "ready" };
const receipt = (input, state, extra = {}) => ({ ...input, state, ...extra });

test("sending clears only the submitted draft and keeps an optimistic message with its files", () => {
 let state = enqueueDot({ draft: "First", inputs: [] }, "dot", [file], "first", "2026-01-01T00:00:00Z");
 assert.equal(state.draft, ""); assert.equal(state.inputs[0].text, "First"); assert.equal(state.inputs[0].attachments[0].name, file.name);
 assert.ok(dotReservedFiles(state, []).has(file.id));
 state = { ...state, draft: "Second draft" };
 state = reconcileDotInput(state, receipt(state.inputs[0], "accepted", { messageId: "remote-first" }));
 assert.equal(state.draft, "Second draft", "late acknowledgement cannot clear the next draft");
 assert.equal(pendingDotMessages(state, "dot", []).length, 1, "accepted receipt bridges delayed native history");
 assert.equal(pendingDotMessages(state, "dot", [{ id: "remote-first" }]).length, 0);
 assert.ok(dotReservedFiles({ draft: "", inputs: [] }, state.inputs).has(file.id), "stale upload metadata cannot reattach delivered files");
});
test("FIFO holds later messages until the earlier delivery is resolved", () => {
 let state = enqueueDot({ draft: "First", inputs: [] }, "dot", [], "first");
 state = enqueueDot({ ...state, draft: "Second" }, "dot", [], "second");
 assert.equal(nextDotInput(state, "dot").id, "first");
 for (const phase of ["sending", "unknown", "not-sent"]) {
  const waiting = reconcileDotInput(state, receipt(state.inputs[0], phase));
  assert.equal(nextDotInput(waiting, "dot"), undefined);
 }
 state = reconcileDotInput(state, receipt(state.inputs[0], "accepted"));
 assert.equal(nextDotInput(state, "dot").id, "second");
 assert.equal(nextDotInput(state, "other-dot"), undefined);
 state = reconcileDotInput(state, receipt(state.inputs[0], "sending"));
 assert.equal(state.inputs[0].state, "accepted", "stale snapshots cannot undo acceptance");
});
test("identical texts are distinct sends and only exact native message IDs reconcile bubbles", () => {
 let state = enqueueDot({ draft: "Same", inputs: [] }, "dot", [], "one");
 state = enqueueDot({ ...state, draft: "Same" }, "dot", [], "two");
 state = reconcileDotInput(state, receipt(state.inputs[0], "accepted", { messageId: "remote-one" }));
 assert.deepEqual(pendingDotMessages(state, "dot", [{ id: "remote-one", text: "Same" }]).map(i => i.id), ["two"]);
 const mismatch = receipt(state.inputs[1], "accepted", { dot: "other-dot" });
 assert.equal(reconcileDotInput(state, mismatch).inputs[1].state, "queued");
});
test("reload retains queued work but never blindly resends an interrupted submission", () => {
 let state = enqueueDot({ draft: "First", inputs: [] }, "dot", [], "one");
 state = reconcileDotInput(state, receipt(state.inputs[0], "sending"));
 state = enqueueDot({ ...state, draft: "Second" }, "dot", [], "two");
 state = { ...state, draft: "Third draft" };
 const values = new Map([[dotOutboxKey("pc"), JSON.stringify(state)]]);
 const loaded = readDotOutbox({ getItem: key => values.get(key) ?? null }, "pc");
 assert.equal(loaded.draft, "Third draft"); assert.equal(loaded.inputs[0].state, "unknown");
 assert.equal(loaded.inputs[1].state, "queued"); assert.equal(nextDotInput(loaded, "dot"), undefined);
 values.clear(); values.set("pi-desk:dot:pc:pending", JSON.stringify({ id: "old", dot: "dot", text: "Old" }));
 values.set("pi-desk:dot:pc:draft", "Saved draft");
 const prior = readDotOutbox({ getItem: key => values.get(key) ?? null }, "pc");
 assert.equal(prior.inputs[0].state, "unknown"); assert.equal(prior.draft, "Saved draft");
});
