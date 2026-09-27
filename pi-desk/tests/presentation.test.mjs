import assert from "node:assert/strict";
import test from "node:test";
import { DeskPresentation } from "../src/host/presentation.ts";
import { getPresentation } from "../../pi-ui/index.ts";

test("native selection context does not become an oversized modal heading", async () => {
	const presentation = new DeskPresentation(() => {}, () => {});
	const ui = presentation.createUi({});
	const result = ui.select("Browser settings\nUser settings · /host/settings.json\nEffective sources: user", ["Endpoint", "Back"]);
	const question = presentation.snapshot().interactions[0];
	try {
		assert.equal(question.form.title, "Browser settings");
		assert.equal(question.form.context, "User settings · /host/settings.json\nEffective sources: user");
	} finally { presentation.answer(question.id, null); await result; }
});

test("structured presentation leases cannot remove replacement views or run commands", async () => {
	const facade = () => {
		const handlers = new Map();
		return { on() {}, events: {
			on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
			emit(name, value) { handlers.get(name)?.(value); },
		} };
	};
	let commands = 0;
	const host = new DeskPresentation(() => {}, () => {}, undefined, undefined, async () => { commands++; });
	const first = facade(); host.install(first);
	const previous = getPresentation(first);
	host.reset();
	const second = facade(); host.install(second);
	getPresentation(second).publish("usage", { kind: "details", title: "Current usage", data: {} });
	previous.publish("usage", undefined);
	assert.equal(host.snapshot().views.length, 1);
	await assert.rejects(previous.runCommand("probe"), /previous session/);
	assert.equal(commands, 0);
	assert.equal(await previous.request({ kind: "confirm", title: "Old", message: "Old" }), null);
});

test("an advertised item action is reachable and rejects a second stale invocation", async () => {
	const presentation = new DeskPresentation(() => {}, () => {});
	let cancelled = 0;
	presentation.publish("scheduler", {
		kind: "details", title: "Scheduled",
		data: { items: [{ id: "timer", title: "Reminder", actions: [{ id: "cancel:timer", label: "Cancel" }] }] },
	}, { "cancel:timer": () => { cancelled++; }, hidden: () => { throw Error("Not advertised"); } });
	const revision = presentation.snapshot().views[0].revision;
	await presentation.act("scheduler", revision, "cancel:timer");
	await assert.rejects(presentation.act("scheduler", revision, "cancel:timer"), /view changed/);
	await assert.rejects(presentation.act("scheduler", presentation.snapshot().views[0].revision, "hidden"), /Unknown action/);
	assert.equal(cancelled, 1);
});

test("native UI callbacks cannot reach a replacement session", async () => {
	const presentation = new DeskPresentation(() => {}, () => {});
	const previous = presentation.createUi({});
	presentation.reset();
	const current = presentation.createUi({});
	current.setEditorText("Current draft");
	assert.equal(await previous.confirm("Old context", "Continue?"), false);
	assert.equal(await previous.input("Old input"), undefined);
	previous.notify("Old notification");
	previous.setStatus("old", "Old status");
	previous.setEditorText("Overwrite");
	previous.setWidget("old", ["Old widget"]);
	assert.equal(previous.getEditorText(), "");
	assert.equal(current.getEditorText(), "Current draft");
	assert.equal(presentation.snapshot().interactions.length, 0);
	assert.equal(presentation.snapshot().notifications.length, 0);
	assert.deepEqual(presentation.snapshot().statuses, {});
	assert.equal(presentation.snapshot().views.length, 0);
});

test("interactive actions acknowledge admission and remain single-flight through view updates", async () => {
	const presentation = new DeskPresentation(() => {}, () => {});
	const view = { kind: "details", title: "Sample", data: {}, actions: [{ id: "edit", label: "Edit" }] };
	const handlers = { edit: async () => {
		await presentation.request({ kind: "input", title: "Sample input" });
		throw new Error("Sample save failure");
	} };
	presentation.publish("sample", view, handlers);
	let admitted = false;
	const response = presentation.act("sample", presentation.snapshot().views[0].revision, "edit")
		.then(result => { admitted = result.accepted; });
	await new Promise(setImmediate);
	try {
		assert.equal(admitted, true, "admission cannot wait for an answer");
		presentation.publish("sample", view, handlers);
		assert.equal(presentation.snapshot().views[0].working, "Edit");
		await assert.rejects(presentation.act("sample", presentation.snapshot().views[0].revision, "edit"), /already in progress/);
		assert.equal(presentation.snapshot().interactions.length, 1);
	} finally { presentation.cancelInteractions(); await response; }
	await new Promise(setImmediate);
	assert.equal(presentation.snapshot().views[0].working, undefined);
	assert.match(presentation.snapshot().views[0].actionError, /Sample save failure/);
	assert.match(presentation.snapshot().notifications[0].text, /Sample save failure/);

	let release;
	presentation.publish("sample", view, { edit: () => new Promise((_, reject) => { release = reject; }) });
	await presentation.act("sample", presentation.snapshot().views[0].revision, "edit");
	presentation.reset();
	presentation.publish("sample", view, {});
	release(new Error("Retired failure"));
	await new Promise(setImmediate);
	assert.equal(presentation.snapshot().views[0].actionError, undefined);
	assert.equal(presentation.snapshot().notifications.length, 0);
});
