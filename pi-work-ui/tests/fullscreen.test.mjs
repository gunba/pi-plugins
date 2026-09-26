import assert from "node:assert/strict";
import test from "node:test";
import { Container, getKeybindings, Spacer, TuiAltScreen, TuiMainScreen, Text, visibleWidth } from "@earendil-works/pi-tui";
import { WorkUi } from "../index.ts";

function overlayUi(tui, theme) {
	let current;
	let lines = [];
	return {
		lines: () => lines,
		current: () => current,
		custom(factory, options) {
			return new Promise(resolve => {
				let handle;
				const component = factory(tui, theme, getKeybindings(), result => {
					handle.hide();
					component.dispose?.();
					current = undefined;
					resolve(result);
				});
				const render = component.render.bind(component);
				component.render = width => lines = render(width);
				current = component;
				handle = tui.showOverlay(component, options.overlayOptions);
			});
		},
	};
}

for (const Renderer of [TuiAltScreen, TuiMainScreen]) test(`native ${Renderer.name} modal preserves the editor across updates and resize`, async t => {
	let input;
	const output = [];
	const terminal = {
		columns: 100, rows: 40, kittyProtocolActive: false,
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {},
		write(data) { output.push(data); }, moveBy() {}, hideCursor() {}, showCursor() {},
		clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const tui = new Renderer(terminal);
	const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
	const overlay = overlayUi(tui, theme);
	let widget;
	const ui = new WorkUi();
	const ctx = { mode: "tui", hasUI: true, ui: {
		custom: overlay.custom,
		setWidget(_key, factory) {
			if (widget) { tui.removeChild(widget); widget.dispose?.(); }
			widget = factory?.(tui, theme);
			if (widget) tui.addChild(widget);
		},
		getToolsExpanded() { throw Error("Global expansion must not control individual work sections"); },
	} };
	ui.start(ctx);
	ui.source("goal").set({ label: "Goal", status: "active", summary: "Summary", detail: `Goal details\n${Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n")}` });
	const todos = ui.source("todos");
	todos.set({ label: "Todos", status: "1 active", summary: "Summary", detail: "Task details" });
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
	if (Renderer === TuiAltScreen) {
		input("\x1b[<0;2;2M");
		input("\x1b[<0;2;2m");
	} else {
		void ui.open(ctx, "goal");
	}
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.match(overlay.lines().join("\n"), /Goal details/);
	assert.doesNotMatch(widget.render(100).join("\n"), /Goal details|Task details/);
	input("\x1b[F");
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.match(overlay.lines().join("\n"), /Line 79/);
	input("\t");
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.match(overlay.lines().join("\n"), /Task details/);
	todos.set({ label: "Todos", status: "done", summary: "Summary", detail: "Task details updated" });
	terminal.columns = 44; terminal.rows = 20; tui.requestRender(true);
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.match(overlay.lines().join("\n"), /Task details updated/);
	assert.ok(overlay.lines().length <= 17);
	assert.ok(overlay.lines().every(line => visibleWidth(line) <= 44));
	assert.equal(editorText, "draft");
	input("\x1b");
	await new Promise(resolve => setTimeout(resolve, 40));
	assert.equal(overlay.current(), undefined);
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
	const overlay = overlayUi(tui, theme);
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
		custom: overlay.custom,
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
	assert.match(overlay.lines().join("\n"), /Goal details/);
	assert.doesNotMatch(overlay.lines().join("\n"), /Task details/);
	input("\x1b"); await settle();
	await gesture("Todo summary");
	assert.doesNotMatch(overlay.lines().join("\n"), /Goal details/);
	assert.match(overlay.lines().join("\n"), /Task details/);
	input("\x1b"); await settle();
	await gesture("Goal summary", true);
	assert.equal(overlay.current(), undefined);
	await gesture("Goal summary");
	assert.match(overlay.lines().join("\n"), /Goal details/);
	assert.doesNotMatch(overlay.lines().join("\n"), /Task details/);
	input("\x1b"); await settle();
	input("!");
	assert.equal(editorText, "draft!");
});
