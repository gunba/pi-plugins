import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen, Text } from "@earendil-works/pi-tui";
import { WorkUi } from "../index.ts";

test("native fullscreen mouse routing expands one work section and preserves editor input", async t => {
	let input;
	const output = [];
	const terminal = {
		columns: 100, rows: 40, kittyProtocolActive: false,
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {},
		write(data) { output.push(data); }, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const tui = new TuiAltScreen(terminal);
	const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
	let widget;
	const ui = new WorkUi();
	const ctx = { mode: "tui", hasUI: true, ui: {
		setWidget(_key, factory) {
			if (widget) { tui.removeChild(widget); widget.dispose?.(); }
			widget = factory?.(tui, theme);
			if (widget) tui.addChild(widget);
		},
		getToolsExpanded() { throw Error("Global expansion must not control individual work sections"); },
	} };
	ui.start(ctx);
	ui.source("goal").set({ label: "Goal", status: "active", summary: "Summary", detail: "Goal details" });
	ui.source("todos").set({ label: "Todos", status: "1 active", summary: "Summary", detail: "Task details" });
	let editorText = "draft";
	const editor = new Text("draft", 0, 0);
	editor.handleInput = data => { editorText += data; };
	tui.addChild(editor);
	tui.setFocus(editor);
	tui.start();
	t.after(() => { ui.close(); tui.stop(); });
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.doesNotMatch(widget.render(100).join("\n"), /Goal details|Task details/);
	// SGR press/release on the Goal header, through Pi's actual fullscreen input path.
	input("\x1b[<0;2;2M");
	input("\x1b[<0;2;2m");
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.match(widget.render(100).join("\n"), /Goal details/);
	assert.doesNotMatch(widget.render(100).join("\n"), /Task details/);
	input("!");
	assert.equal(editorText, "draft!");
	assert.ok(output.length > 0);
});
