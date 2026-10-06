import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DeskPresentation } from "../../pi-desk/src/host/presentation.ts";
import { SubagentPresentation } from "../extensions/presentation.ts";
import { blockingPrompt, childParent, createHarness, FakeDriverFactory, waitUntil } from "./helpers.mjs";

test("inactive agents use compact history and open without starting work", async () => {
	const children = Array.from({ length: 350 }, (_, index) => ({ id: `old-${index}`, label: `Earlier ${index}`, state: "settled",
		mode: "continuable", parentId: "root", depth: 1, model: "test/model", thinkingLevel: "medium", queued: 0 }));
	children.push({ ...children[0], id: "live", label: "Live", state: "running" });
	let transcripts = 0, work = 0;
	const runtime = { host: { rootSessionId: "root" }, snapshot: () => children, transcript: () => { transcripts++; return {}; },
		start: () => { work++; }, followupTask: () => { work++; }, interrupt: () => { work++; } };
	const opened = [], remote = new DeskPresentation(() => {}, id => opened.push(id), undefined,
		() => ({ id: randomUUID(), close: () => {} }));
	const controller = new SubagentPresentation(remote, runtime, () => ({}), { status: () => "unset" });
	try {
		controller.refresh();
		const snapshot = remote.snapshot();
		assert.equal(snapshot.views.filter(view => view.kind === "conversation").length, 1);
		assert.equal(transcripts, 1, "inactive transcript handles should be created on demand");
		const history = snapshot.views.find(view => view.id === "subagents");
		assert.equal(history.data.items.length, 350);
		assert.ok(JSON.stringify(snapshot).length < 100_000);
		const action = history.data.items[0].actions[0];
		await remote.act(history.id, history.revision, action.id);
		assert.equal(opened.at(-1), "agent:old-0");
		assert.ok(remote.snapshot().views.find(view => view.id === "agent:old-0").data.transcript);
		assert.equal(transcripts, 2);
		assert.equal(work, 0, "opening history must not launch, resume, follow up or interrupt a child");
	} finally { controller.close(); }
});

test("agent panes use owned transcripts and native parent admission, without a separate worker or modal editor", async () => {
	const factory = new FakeDriverFactory(blockingPrompt), harness = createHarness({ factory });
	const sources = new Map(), opened = [], emitted = [];
	const remote = new DeskPresentation(snapshot => emitted.push(snapshot), id => opened.push(id), undefined, source => {
		const id = randomUUID(); sources.set(id, source); return { id, close: () => sources.delete(id) };
	});
	const controller = new SubagentPresentation(remote, harness.runtime, () => harness.parent(), { status: () => "unset" });
	const unsubscribe = harness.runtime.subscribe(() => controller.refresh());
	const view = id => remote.snapshot().views.find(view => view.id === `agent:${id}`);
	const invoke = (id, action, text) => { const current = view(id); return remote.act(current.id, current.revision, action, text); };
	try {
		const first = await harness.runtime.start({ description: "First", prompt: "work", context: "fresh", runInBackground: true, parent: harness.parent() });
		await waitUntil(() => factory.opens[0]?.isRunning);
		controller.refresh();
		assert.equal(view(first.subagentId).kind, "conversation");
		assert.ok(sources.get(view(first.subagentId).data.transcript).branch().length);
		assert.equal(view(first.subagentId).data.active, true);
		controller.open(first.subagentId); assert.equal(opened.at(-1), view(first.subagentId).id);
		await invoke(first.subagentId, "steer", "current update");
		assert.match(factory.opens[0].notices[0].content, /current update/);
		await invoke(first.subagentId, "followup", "next task");
		assert.equal(factory.promptLog.length, 1);
		assert.equal(view(first.subagentId).data.fields.find(field => field.label === "Queued tasks").value, "1");
		assert.equal(remote.snapshot().interactions.length, 0);

		const second = await harness.runtime.start({ description: "Second", prompt: "more", context: "fresh", runInBackground: true, parent: harness.parent() });
		const grandchild = await harness.runtime.start({ description: "Nested", prompt: "nested", context: "fresh", runInBackground: true,
			parent: childParent(harness, first.subagentId, factory.opens[0].input.authority) });
		await waitUntil(() => factory.opens.length === 3 && factory.opens.every(driver => driver.isRunning));
		controller.refresh();
		assert.equal(view(grandchild.subagentId).actions.some(action => action.input === "message"), true);
		assert.equal(view(grandchild.subagentId).actions.find(action => action.id === "followup").label, "Follow up");
		await invoke(grandchild.subagentId, "steer", "nested update");
		assert.match(factory.opens.find(driver => driver.input.descriptor.childSessionId === grandchild.subagentId).notices[0].content, /nested update/);
		await invoke(grandchild.subagentId, "followup", "nested task");
		await invoke(first.subagentId, "stop");
		assert.equal(factory.opens[0].interruptions, 1);
		assert.equal(factory.opens.find(driver => driver.input.descriptor.childSessionId === second.subagentId).interruptions, 0);
		assert.equal(factory.opens.find(driver => driver.input.descriptor.childSessionId === grandchild.subagentId).interruptions, 0);
		const before = emitted.length;
		remote.batch(() => {
			for (let index = 0; index < 500; index++) remote.publish(`fixture:${index}`, { kind: "text", title: "Fixture", data: "" });
		});
		assert.equal(emitted.length - before, 1, "one update for a collection, not a growing snapshot per row");
	} finally {
		unsubscribe(); controller.close();
		assert.equal(sources.size, 0);
		await harness.cleanup();
	}
});
