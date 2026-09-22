import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { PartyStore } from "./store.ts";
import { PartyChat } from "./chat.ts";
import { renderPartyCall, renderPartyResult, renderPartyNotice } from "./render.ts";

const theme = { fg: (_color, text) => text, bold: text => text };
const sender = "11111111-1111-4111-8111-111111111111", recipient = "22222222-2222-4222-8222-222222222222";
function fixture(t) {
	initTheme("dark", false);
	const directory = mkdtempSync(join(tmpdir(), "pi-party-chat-"));
	let time = 1789300000000, height = 24, closed = 0;
	const db = new PartyStore(directory, () => time++);
	db.join(sender, "a", "cleanup", "Copilot Skills");
	db.join(recipient, "b", "cleanup", "Studio Bridge");
	t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
	return { db, send: text => db.send(sender, "a", "all", text, true), height: value => { height = value; },
		view: () => new PartyChat({ room: "cleanup", session: sender, theme, height: () => height, requestRender() {}, done() { closed++; }, load: query => db.history(sender, "a", query) }), closed: () => closed };
}
const plain = (view, width = 100) => stripVTControlCharacters(view.render(width).join("\n"));

test("chat displays names and Markdown, clamps widths and keeps complete long messages accessible", t => {
	const f = fixture(t);
	f.send("**Ready to review**\n\n- Check the result\n- Share findings\n\n```js\nconst ready = true;\n```");
	const view = f.view();
	const output = plain(view);
	assert.match(output, /Copilot Skills \(you\) → Studio Bridge/);
	assert.match(output, /Ready to review/);
	assert.match(output, /const ready = true/);
	assert.doesNotMatch(output, /11111111|22222222|\*\*Ready/);
	for (const width of [1, 5, 24, 80, 140]) for (const height of [3, 12, 30]) {
		f.height(height);
		const lines = view.render(width);
		assert.equal(lines.length, height);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
	}
	f.height(24);
	f.send("START-OF-LONG-MESSAGE\n" + "Complete line 🧪\n".repeat(5000) + "END-OF-LONG-MESSAGE");
	view.refresh();
	assert.match(plain(view), /END-OF-LONG-MESSAGE/);
	view.handleInput("\x1b[H");
	assert.match(plain(view), /Ready to review/);
	view.handleInput("\x1b[F");
	assert.match(plain(view), /END-OF-LONG-MESSAGE/);
});

test("history navigation holds position during arrivals and End resumes following", t => {
	const f = fixture(t);
	for (let i = 0; i < 45; i++) f.send(`Message ${i}`);
	const view = f.view();
	assert.match(plain(view), /Message 44/);
	view.handleInput("\x1b[H");
	assert.match(plain(view), /Message 0\b/);
	f.send("Newest arrival"); view.refresh();
	assert.match(plain(view), /Message 0\b/);
	assert.doesNotMatch(plain(view), /Newest arrival/);
	view.handleInput("\x1b[C");
	assert.match(plain(view), /Message 20\b/);
	view.handleInput("\x1b[F");
	assert.match(plain(view), /Newest arrival/);
	view.handleMouse({ type: "wheel", wheelDelta: -4, alt: false, ctrl: false, shift: false });
	f.send("Another arrival"); view.refresh();
	assert.doesNotMatch(plain(view), /Another arrival/);
	view.handleInput("\x1b[F");
	assert.match(plain(view), /Another arrival/);
	view.handleInput("\x1b");
	assert.equal(f.closed(), 1);
	assert.deepEqual(view.render(100), []);
});

test("chat reports read failures and refuses a changed room without rendering its history", t => {
	const f = fixture(t);
	f.send("Visible room");
	const view = f.view();
	f.db.join(sender, "a", "other", "Copilot Skills");
	view.refresh();
	assert.match(plain(view), /Party membership changed/);
	assert.doesNotMatch(plain(view), /Party other/);
});

test("party tool and incoming previews retain useful text and names without exposing IDs", () => {
	initTheme("dark", false);
	const text = "**Cleanup ready**\n\nSecond paragraph with the full findings.";
	const args = Object.freeze({ to: recipient, message: text, wake: false });
	const result = Object.freeze({ content: Object.freeze([Object.freeze({ type: "text", text: JSON.stringify({ queued: [{ id: "receipt-private", to: recipient }] }) })]), details: Object.freeze({}) });
	const before = JSON.stringify({args, result});
	const label = id => id === recipient ? "Studio Bridge" : "Copilot Skills";
	const ctx = { args, expanded: false, isError: false };
	const call = renderPartyCall("send", args, theme, ctx, label);
	const status = renderPartyResult("send", result, { expanded: false, isPartial: false }, theme, ctx, label);
	assert.match(plain(call), /Direct → Studio Bridge/);
	assert.match(plain(call), /Cleanup ready/);
	assert.match(plain(status), /FYI · no wake/);
	assert.doesNotMatch(plain(status), /receipt-private|22222222/);
	assert.match(plain(renderPartyCall("send", args, theme, { ...ctx, expanded: true }, label)), /Second paragraph/);
	assert.match(plain(renderPartyCall("send", { ...args, to: "all" }, theme, ctx, label)), /everyone/);
	const notice = { content: `Party cleanup · Copilot Skills (${sender})\n\n${text}` };
	assert.match(plain(renderPartyNotice(notice, { expanded: false }, theme)), /Cleanup ready/);
	assert.doesNotMatch(plain(renderPartyNotice(notice, { expanded: true }, theme)), /11111111/);
	for (const width of [1, 5, 25, 80]) assert.ok(call.render(width).every(line => visibleWidth(line) <= width));
	assert.equal(JSON.stringify({args, result}), before);
});

test("native fullscreen overlay routes navigation and mouse scrolling, then restores editor focus", async t => {
	const f = fixture(t);
	for (let i = 0; i < 30; i++) f.send(`Message ${i}`);
	let input, overlay, draft = "unsent draft";
	const terminal = { columns: 100, rows: 40, kittyProtocolActive: false,
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
	const tui = new TuiAltScreen(terminal);
	const editor = new Text(draft, 0, 0);
	editor.handleInput = data => { draft += data; };
	tui.addChild(editor); tui.setFocus(editor); tui.start();
	const view = new PartyChat({ room: "cleanup", session: sender, theme, height: () => 24,
		requestRender: () => tui.requestRender(), done: () => overlay.hide(), load: query => f.db.history(sender, "a", query) });
	overlay = tui.showOverlay(view, { width: 80, anchor: "center", maxHeight: "85%" });
	t.after(() => { view.dispose(); tui.stop(); });
	const settle = () => new Promise(resolve => setTimeout(resolve, 50));
	await settle();
	input("\x1b[H"); await settle();
	assert.match(plain(view, 80), /Message 0\b/);
	input("\x1b[F"); await settle();
	assert.match(plain(view, 80), /Message 29\b/);
	input("\x1b[<64;30;20M"); await settle();
	assert.doesNotMatch(plain(view, 80), /Following the conversation/);
	input("\x1b"); await settle();
	assert.equal(tui.hasOverlay(), false);
	input("!");
	assert.equal(draft, "unsent draft!");
});

test("native tool expansion reveals the complete sent message and keeps receipts out of the UI", async () => {
	initTheme("dark", false);
	const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
	const args = { to: recipient, message: "**Summary**\n\n" + "More findings\n".repeat(30) + "Final detail" };
	const result = { content: [{ type: "text", text: JSON.stringify({ queued: [{ id: "receipt-private", to: recipient }] }) }], details: {}, isError: false };
	const before = JSON.stringify(result);
	const label = () => "Studio Bridge";
	const definition = { name: "party_send", renderCall: (args, theme, context) => renderPartyCall("send", args, theme, context, label),
		renderResult: (result, options, theme, context) => renderPartyResult("send", result, options, theme, context, label) };
	const component = new ToolExecutionComponent("party_send", "call", args, {}, definition, { terminal: { columns: 100, rows: 40 }, requestRender() {} }, process.cwd());
	component.updateResult(result);
	assert.match(plain(component), /Studio Bridge/);
	assert.doesNotMatch(plain(component), /Final detail|receipt-private|22222222/);
	component.setExpanded(true);
	assert.match(plain(component), /Final detail/);
	component.setExpanded(false);
	const lines = component.render(100), y = lines.findIndex(line => line.includes("Direct →"));
	assert.equal(component.handleMouse({ type: "click", button: "left", x: 3, y, screenX: 3, screenY: y, width: 100, height: lines.length, shift: false, alt: false, ctrl: false }).handled, true);
	assert.match(plain(component), /Final detail/);
	assert.equal(JSON.stringify(result), before);
});
