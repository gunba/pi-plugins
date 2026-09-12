import assert from "node:assert/strict";
import test from "node:test";
import { Container, Spacer, TuiAltScreen, Text } from "@earendil-works/pi-tui";
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

test("native chat input dock routes a complete mouse gesture to work controls", async t => {
	const { createChatViewport } = await import(new URL(
		"./modes/interactive/chat-viewport.js",
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	));
	let input;
	const terminal = {
		columns: 100, rows: 40, kittyProtocolActive: false,
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {},
		write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const tui = new TuiAltScreen(terminal);
	const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
	const document = new Container(), widgetsAbove = new Container(), editor = new Text("draft\n\n", 0, 0);
	document.addChild(new Text(Array.from({ length: 100 }, (_, i) => `Transcript ${i}`).join("\n"), 0, 0));
	let editorText = "draft";
	editor.handleInput = data => { editorText += data; };
	const viewport = createChatViewport({
		document, pendingMessages: new Container(), status: new Container(), widgetsAbove,
		editor, footer: new Text("Footer", 0, 0),
	});
	tui.setLayoutRoot(viewport.root);
	for (const component of [document, widgetsAbove, editor]) tui.addChild(component);
	const ui = new WorkUi();
	let widget;
	ui.start({ mode: "tui", hasUI: true, ui: {
		setWidget(_key, factory) {
			widget?.dispose?.();
			widgetsAbove.clear();
			widgetsAbove.addChild(new Spacer(1));
			widget = factory?.(tui, theme);
			if (widget) widgetsAbove.addChild(widget);
			tui.requestRender();
		},
	} });
	ui.source("goal").set({ label: "Goal", status: "active", summary: "Goal summary", detail: "Goal details" });
	ui.source("todos").set({ label: "Todos", status: "active", summary: "Todo summary", detail: "Task details" });
	tui.setFocus(editor);
	tui.start();
	t.after(() => { ui.close(); tui.stop(); });
	const frame = () => tui.currentLayout.lines;
	const settle = () => new Promise(resolve => setTimeout(resolve, 60));
	const gesture = async (label, drag = false) => {
		const y = frame().findIndex(line => line.includes(label));
		assert.ok(y > 0, `Missing dock control ${label}`);
		input(`\x1b[<0;2;${y + 1}M`);
		if (drag) input(`\x1b[<32;3;${y + 1}M`);
		input(`\x1b[<0;${drag ? 3 : 2};${y + 1}m`);
		await settle();
	};
	await settle();
	assert.doesNotMatch(frame().join("\n"), /Goal details|Task details/);
	await gesture("Goal summary");
	// Inspect the actual rendered frame, not a fresh manual widget render.
	assert.match(frame().join("\n"), /Goal details/);
	assert.doesNotMatch(frame().join("\n"), /Task details/);
	await gesture("Todo summary");
	assert.match(frame().join("\n"), /Goal details/);
	assert.match(frame().join("\n"), /Task details/);
	await gesture("Goal summary", true);
	assert.match(frame().join("\n"), /Goal details/);
	await gesture("Goal summary");
	assert.doesNotMatch(frame().join("\n"), /Goal details/);
	assert.match(frame().join("\n"), /Task details/);
	input("!");
	assert.equal(editorText, "draft!");
});
