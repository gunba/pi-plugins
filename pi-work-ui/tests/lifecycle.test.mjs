import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEventBus, DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { ensureWorkUi, WorkUi } from "../index.ts";

const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
const keys = { "tui.select.confirm": "enter", "tui.select.cancel": "escape", "tui.select.down": "down", "tui.select.up": "up", "tui.select.pageDown": "pageDown", "tui.select.pageUp": "pageUp" };
const keybindings = { matches(data, action) { return keys[action] ? matchesKey(data, keys[action]) : false; }, getKeys(action) { return keys[action] ? [keys[action]] : []; } };
const section = (text = "Current objective") => ({ label: "Goal", status: "active", summary: text, detail: text });

function harness(mode = "tui") {
	const widgets = [];
	const overlays = [];
	const notices = [];
	let renders = 0;
	const tui = { terminal: { rows: 40 }, requestRender() { renders++; } };
	const ctx = { mode, hasUI: mode === "tui" || mode === "rpc", ui: {
		setWidget(key, factory, options) {
			widgets.at(-1)?.component?.dispose();
			widgets.push({ key, factory, options, component: factory?.(tui, theme) });
		},
		notify(...args) { notices.push(args); },
		custom(factory, options) {
			let resolve;
			const promise = new Promise((done) => { resolve = done; });
			const entry = { options, component: undefined, resolve(value) { entry.component?.dispose(); resolve(value); } };
			entry.component = factory(tui, theme, keybindings, entry.resolve);
			overlays.push(entry);
			return promise;
		},
	} };
	return { ctx, tui, widgets, overlays, notices, renders: () => renders, lines: () => widgets.at(-1)?.component?.render(100) ?? [] };
}

test("one widget integrates three sources in stable order without footer/editor access", () => {
	const h = harness();
	const ui = new WorkUi();
	ui.start(h.ctx);
	const agents = ui.source("subagents");
	const todos = ui.source("todos");
	const goal = ui.source("goal");
	agents.set({ ...section("Agents"), label: "Subagents" });
	todos.set({ ...section("Tasks"), label: "Todos" });
	goal.set(section());
	assert.equal(h.widgets.length, 1);
	assert.equal(h.widgets[0].key, "pi-work");
	assert.deepEqual(h.widgets[0].options, { placement: "aboveEditor" });
	assert.deepEqual(ui.snapshot().map(([id]) => id), ["goal", "todos", "subagents"]);
	assert.equal(h.lines().length, 4);
	goal.set(section("Updated objective"));
	assert.match(h.lines().join("\n"), /Updated objective/);
	assert.equal(h.widgets.length, 1);
	assert.ok(h.renders() >= 4);
	goal.dispose();
	assert.equal(h.lines().length, 3);
	todos.dispose();
	agents.dispose();
	assert.equal(h.widgets.at(-1).factory, undefined);
});

test("source snapshots are detached from the producer and superseded leases cannot clear the replacement", () => {
	const h = harness();
	const ui = new WorkUi(); ui.start(h.ctx);
	const old = ui.source("goal");
	const data = section(); old.set(data); data.summary = "mutated";
	assert.doesNotMatch(h.lines().join("\n"), /mutated/);
	const current = ui.source("goal"); current.set(section("Replacement"));
	old.set(section("stale")); old.dispose();
	assert.match(h.lines().join("\n"), /Replacement/);
	assert.doesNotMatch(h.lines().join("\n"), /stale/);
});

test("branch replacement retires old publishers, renders and overlays before accepting restored state", async () => {
	const h = harness();
	const ui = new WorkUi(); ui.start(h.ctx);
	const old = ui.source("goal"); old.set(section("Abandoned branch"));
	const widget = h.widgets.at(-1).component;
	const open = ui.open(h.ctx, "goal");
	const overlay = h.overlays.at(-1).component;
	ui.start(h.ctx);
	const current = ui.source("goal"); current.set(section("Selected branch"));
	await open;
	old.set(section("Abandoned late update"));
	old.dispose(); overlay.update([["goal", section("stale overlay")]]);
	assert.match(h.lines().join("\n"), /Selected branch/);
	assert.deepEqual(widget.render(100), []);
	assert.deepEqual(overlay.render(100), []);
	assert.equal(h.overlays.length, 1);
});

test("shutdown gates callbacks before old context reads and is idempotent", async () => {
	const h = harness();
	const ui = new WorkUi(); ui.start(h.ctx);
	const source = ui.source("goal"); source.set(section());
	const widget = h.widgets.at(-1).component;
	const open = ui.open(h.ctx, "goal");
	const oldView = h.overlays.at(-1).component;
	ui.close();
	Object.defineProperty(h.ctx, "ui", { get() { throw Error("retired UI read"); } });
	Object.defineProperty(h.ctx, "mode", { get() { throw Error("retired mode read"); } });
	ui.close(); ui.start(h.ctx); source.set(section("stale")); source.dispose();
	oldView.handleInput("\r"); oldView.update([["goal", section("stale")]]);
	assert.deepEqual(widget.render(80), []);
	assert.deepEqual(oldView.render(80), []);
	await open;
	await ui.open(h.ctx);
	assert.deepEqual(ui.snapshot(), []);
});

test("real SDK invalidation without shutdown cannot fail a late work publication", async (t) => {
	let source;
	let ui;
	const result = await load(t, [(pi) => {
		ui = ensureWorkUi(pi);
		pi.on("session_start", () => { source = ui.source("goal"); });
	}], createEventBus());
	const h = harness();
	const runner = new ExtensionRunner(result.extensions, result.runtime, tmpdir(), SessionManager.inMemory(tmpdir()), {});
	runner.bindCore({}, {});
	runner.setUIContext(h.ctx.ui, "tui");
	await runner.emit({ type: "session_start", reason: "new" });
	source.set(section("live"));
	const ctx = runner.createContext();
	const widget = h.widgets.at(-1).component;
	runner.invalidate();
	assert.throws(() => ctx.ui, /extension ctx is stale/);
	assert.doesNotThrow(() => source.set(section("late")));
	assert.deepEqual(ui.snapshot(), []);
	assert.deepEqual(widget.render(80), []);
});

test("invalidation without shutdown retires a publisher without failing its task", () => {
	const h = harness();
	const ui = new WorkUi(); ui.start(h.ctx);
	const source = ui.source("goal"); source.set(section());
	const widget = h.widgets.at(-1).component;
	Object.defineProperty(h.ctx, "mode", { get() { throw Error("This extension ctx is stale after reload."); } });
	assert.doesNotThrow(() => source.set(section("late update")));
	assert.doesNotThrow(() => source.dispose());
	assert.deepEqual(ui.snapshot(), []);
	assert.deepEqual(widget.render(80), []);
});

test("replacement accepts the new context even if the old UI was already invalidated", () => {
	const old = harness();
	const current = harness();
	const ui = new WorkUi(); ui.start(old.ctx);
	const source = ui.source("goal"); source.set(section("old"));
	Object.defineProperty(old.ctx, "ui", { get() { throw Error("This extension ctx is stale after reload."); } });
	assert.doesNotThrow(() => ui.start(current.ctx));
	ui.source("goal").set(section("new context"));
	source.dispose();
	assert.match(current.lines().join("\n"), /new context/);
});

test("unexpected passive rendering failures remain visible but cannot fail a task", (t) => {
	const warnings = [];
	t.mock.method(console, "warn", (...args) => warnings.push(args));
	const h = harness();
	h.ctx.ui.setWidget = () => { throw Error("fixture renderer failure"); };
	const ui = new WorkUi(); ui.start(h.ctx);
	const source = ui.source("goal");
	assert.doesNotThrow(() => source.set(section()));
	assert.doesNotThrow(() => source.set(section("ignored")));
	assert.equal(warnings.length, 1);
	assert.match(String(warnings[0][1]), /fixture renderer failure/);
	assert.deepEqual(ui.snapshot(), []);
});

test("view updates while open, closes to collapsed panel, and routes dashboard without stale continuations", async () => {
	const h = harness();
	const ui = new WorkUi(); ui.start(h.ctx);
	const source = ui.source("subagents");
	let actions = 0;
	source.set({ ...section("First"), label: "Subagents", action: { label: "dashboard", run: async (ctx) => { assert.equal(ctx, h.ctx); actions++; } } });
	const open = ui.open(h.ctx, "subagents");
	assert.equal(h.overlays[0].options.overlay, true);
	assert.equal(h.overlays[0].options.overlayOptions.maxHeight, "70%");
	const view = h.overlays[0].component;
	source.set({ ...section("Second"), label: "Subagents", action: { label: "dashboard", run: async () => { actions++; } } });
	assert.match(view.render(100).join("\n"), /Second/);
	view.handleInput("d"); await open;
	assert.equal(actions, 1);
	assert.deepEqual(view.render(100), []);
	const secondOpen = ui.open(h.ctx);
	assert.doesNotMatch(h.overlays[1].component.render(100).join("\n"), /Second/);
	h.overlays[1].resolve("subagents");
	ui.start(h.ctx); // branch changes after selection, before the async continuation
	await secondOpen;
	assert.equal(actions, 1);
});

test("old overlay completion cannot erase a new-branch overlay", async () => {
	const h = harness(); const ui = new WorkUi(); ui.start(h.ctx);
	ui.source("goal").set(section());
	const oldOpen = ui.open(h.ctx, "goal");
	ui.start(h.ctx); ui.source("goal").set(section("New branch"));
	const newOpen = ui.open(h.ctx, "goal");
	await oldOpen;
	ui.close(); // must still know which new overlay to close
	await newOpen;
	assert.deepEqual(h.overlays[1].component.render(80), []);
});

test("RPC/print modes never instantiate terminal widgets or overlays", async () => {
	for (const mode of ["rpc", "print", "json"]) {
		const h = harness(mode); const ui = new WorkUi(); ui.start(h.ctx);
		ui.source("goal").set(section());
		await ui.open(h.ctx);
		assert.equal(h.widgets.length, 0); assert.equal(h.overlays.length, 0);
		ui.close();
	}
});

async function load(t, factories, bus = createEventBus()) {
	const directory = mkdtempSync(join(tmpdir(), "pi-work-ui-loading-"));
	const loader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, eventBus: bus, settingsManager: SettingsManager.inMemory(),
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: factories,
	});
	await loader.reload();
	const result = loader.getExtensions();
	t.after(() => { result.runtime.invalidate(); rmSync(directory, { recursive: true, force: true }); });
	return result;
}
function assertOneRegistration(result) {
	const commands = result.extensions.flatMap((extension) => [...extension.commands.keys()]);
	assert.deepEqual(commands, ["work"]);
	assert.equal(result.extensions.filter((extension) => extension.handlers.has("session_start")).length, 1);
	assert.equal(result.extensions.filter((extension) => extension.handlers.has("session_tree")).length, 1);
	assert.equal(result.extensions.flatMap((extension) => [...extension.shortcuts.keys()]).length, 0);
}

test("real loader registers once for distinct API facades on the same underlying event bus", async (t) => {
	const facades = []; const hubs = [];
	const result = await load(t, ["goal", "todo", "subagents"].map((name) => ({ name, factory(pi) {
		facades.push(pi.events); hubs.push(ensureWorkUi(pi)); assert.equal(ensureWorkUi(pi), hubs.at(-1));
	} })));
	assert.deepEqual(result.errors, []);
	assert.equal(new Set(facades).size, 3);
	assert.equal(new Set(hubs).size, 1);
	assertOneRegistration(result);
});

test("standalone consumers each register their own panel and command", async (t) => {
	const hubs = [];
	for (const name of ["goal", "todos", "subagents"]) {
		const result = await load(t, [{ name, factory(pi) { hubs.push(ensureWorkUi(pi)); } }]);
		assert.deepEqual(result.errors, []); assertOneRegistration(result);
	}
	assert.equal(new Set(hubs).size, 3);
});

test("loader invalidation and failed factories release the discovery claim", async (t) => {
	const bus = createEventBus();
	const first = await load(t, [ensureWorkUi], bus); assertOneRegistration(first);
	first.runtime.invalidate();
	const second = await load(t, [ensureWorkUi], bus); assertOneRegistration(second);
	const failed = await load(t, [
		{ name: "failed", factory(pi) { ensureWorkUi(pi); throw Error("fixture factory failed"); } },
		{ name: "working", factory: ensureWorkUi },
	]);
	assert.equal(failed.errors.length, 1); assertOneRegistration(failed);
});

test("shutdown releases registration on a shared bus and old publishers cannot affect reload", async () => {
	const bus = createEventBus();
	const handlers = new Map(); const commands = [];
	const pi = { events: bus, on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); }, registerCommand(name) { commands.push(name); } };
	const old = ensureWorkUi(pi); const oldCtx = harness(); old.start(oldCtx.ctx);
	const publisher = old.source("goal"); publisher.set(section("old"));
	for (const handler of handlers.get("session_shutdown")) handler({}, oldCtx.ctx);
	const current = ensureWorkUi(pi); const newCtx = harness(); current.start(newCtx.ctx);
	current.source("goal").set(section("new"));
	publisher.set(section("stale"));
	assert.notEqual(old, current);
	assert.deepEqual(commands, ["work", "work"]);
	assert.match(newCtx.lines().join("\n"), /new/);
	assert.doesNotMatch(newCtx.lines().join("\n"), /stale/);
	current.close();
});
