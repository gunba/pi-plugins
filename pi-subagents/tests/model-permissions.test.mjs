import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationModelPermissions } from "../extensions/model-permissions.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DESCRIPTOR_ENTRY } from "../extensions/subagent-runtime.ts";
import { createSubagentToolDefinitions } from "../extensions/subagent-tools.ts";
import { createHarness, deferred, waitUntil } from "./helpers.mjs";

const selection = { model: { provider: "test", id: "small" }, thinkingLevel: "low" };
const capable = { provider: "test", id: "model", api: "test", reasoning: true, input: ["text"] };

function permissionsHarness(t, confirm, sessionId = "root") {
	const directory = mkdtempSync(join(tmpdir(), "subagent-permissions-"));
	const permissions = new ConversationModelPermissions(directory, sessionId, { available: true, confirm });
	t.after(() => { permissions.dispose(); rmSync(directory, { recursive: true, force: true }); });
	return { directory, permissions };
}

test("one user approval covers concurrent requests, later requests and resume", async t => {
	const answer = deferred();
	let prompts = 0;
	const { directory, permissions } = permissionsHarness(t, async () => { prompts++; return answer.promise; });
	const first = permissions.authorize(selection);
	const second = permissions.authorize({ ...selection, thinkingLevel: "high" });
	assert.equal(prompts, 1);
	answer.resolve(true);
	await Promise.all([first, second]);
	await permissions.authorize(selection);
	assert.equal(prompts, 1);
	permissions.dispose();
	const resumed = new ConversationModelPermissions(directory, "root", { available: true, confirm: () => { throw Error("must not ask again"); } });
	t.after(() => resumed.dispose());
	await resumed.authorize(selection);
});

test("new and forked conversation ids do not inherit an approval", async t => {
	const { directory, permissions } = permissionsHarness(t, async () => true);
	await permissions.authorize(selection);
	const fork = new ConversationModelPermissions(directory, "fork-id", { available: true, confirm: async () => false });
	t.after(() => fork.dispose());
	assert.equal(fork.status(), "ask");
	await assert.rejects(fork.authorize(selection), /user approval/);
	assert.equal(permissions.status(), "allowed");
});

test("denial does not nag; a later explicit user permission command can reopen approval", async t => {
	let allowed = false, prompts = 0;
	const { permissions } = permissionsHarness(t, async () => { prompts++; return allowed; });
	await assert.rejects(permissions.authorize(selection), /user approval/);
	await assert.rejects(permissions.authorize(selection), /user approval/);
	assert.equal(prompts, 1);
	allowed = true;
	await permissions.allow();
	assert.equal(prompts, 2);
	await permissions.authorize(selection);
	permissions.revoke();
	await assert.rejects(permissions.authorize(selection), /user approval/);
	assert.equal(prompts, 2);
});

test("noninteractive operation cannot grant permission", async t => {
	const { directory } = permissionsHarness(t, async () => true);
	const headless = new ConversationModelPermissions(directory, "headless", { available: false, confirm: async () => true });
	t.after(() => headless.dispose());
	await assert.rejects(headless.authorize(selection), /user approval/);
	assert.equal(headless.status(), "ask");
});

for (const cancel of ["abort", "revoke", "dispose"]) test(`${cancel} prevents a late UI response from granting permission`, async t => {
	const answer = deferred();
	const { permissions } = permissionsHarness(t, () => answer.promise);
	const controller = new AbortController();
	const pending = permissions.authorize(selection, controller.signal);
	const rejection = assert.rejects(pending);
	if (cancel === "abort") controller.abort();
	else if (cancel === "revoke") permissions.revoke();
	else permissions.dispose();
	answer.resolve(true);
	await rejection;
	assert.notEqual(permissions.status(), "allowed");
});

test("a revocation from another root instance wins over an outstanding approval", async t => {
	const answer = deferred();
	const { directory, permissions } = permissionsHarness(t, () => answer.promise);
	const pending = permissions.authorize(selection);
	const other = new ConversationModelPermissions(directory, "root", { available: true, confirm: async () => true });
	t.after(() => other.dispose());
	other.revoke();
	answer.resolve(true);
	await assert.rejects(pending, /changed while approval/);
	assert.equal(permissions.status(), "denied");
});

function request(harness, overrides = {}) {
	return { description: "Check selected model", prompt: "test task", context: "fresh", runInBackground: true,
		parent: harness.parent({ model: capable }), ...overrides };
}

test("runtime rejects every override without a permission host before creating a child", async t => {
	const h = createHarness(); t.after(() => h.cleanup());
	h.host.resolveModel = ref => ({ ...capable, ...ref });
	await assert.rejects(h.runtime.start(request(h, { model: "test/small" })), /user approval/);
	await assert.rejects(h.runtime.start(request(h, { thinkingLevel: "low" })), /user approval/);
	assert.equal(h.factory.opens.length, 0);
	assert.deepEqual(readdirSync(h.childSessions), []);
	await h.runtime.start(request(h));
	await waitUntil(() => h.factory.opens.length === 1);
	assert.deepEqual(h.factory.opens[0].input.descriptor.model, { provider: "test", id: "model" });
	assert.equal(h.factory.opens[0].input.descriptor.thinkingLevel, "high");
});

for (const context of ["fresh", "fork"]) test(`${context} persists the approved model and effort for cold continuation`, async t => {
	const h = createHarness(); t.after(() => h.cleanup());
	h.host.resolveModel = ref => ({ ...capable, ...ref });
	let approvals = 0;
	h.host.authorizeModelOverrides = async choice => { approvals++; assert.deepEqual(choice, selection); };
	const result = await h.runtime.start(request(h, { context, model: "test/small", thinkingLevel: "low" }));
	await waitUntil(() => h.factory.opens[0]?.disposed);
	const manager = SessionManager.open(h.runtime.getSessionFile(result.subagentId));
	const descriptor = manager.getEntries().find(e => e.customType === DESCRIPTOR_ENTRY).data;
	assert.deepEqual(descriptor.model, selection.model);
	assert.equal(descriptor.thinkingLevel, "low");
	h.host.authorizeModelOverrides = async () => { throw Error("new creation permission revoked"); };
	h.runtime.followupTask(h.runtime.rootAuthority, result.subagentId, "continue");
	await waitUntil(() => h.factory.opens.length === 2);
	assert.deepEqual(h.factory.opens[1].input.descriptor.model, selection.model);
	assert.equal(h.factory.opens[1].input.descriptor.thinkingLevel, "low");
	assert.equal(approvals, 1);
});

test("unavailable models and unsupported effort fail before any permission dialog", async t => {
	const h = createHarness(); t.after(() => h.cleanup());
	let approvals = 0; h.host.authorizeModelOverrides = async () => { approvals++; };
	h.host.resolveModel = () => undefined;
	await assert.rejects(h.runtime.start(request(h, { model: "missing-model" })), /provider\/model/);
	await assert.rejects(h.runtime.start(request(h, { model: "test/missing" })), /unavailable/);
	await assert.rejects(h.runtime.start(request(h, { thinkingLevel: "ultra" })), /thinking level.*unavailable/);
	assert.equal(approvals, 0);
	assert.deepEqual(readdirSync(h.childSessions), []);
});

test("model-only selection adapts inherited effort to the selected model", async t => {
	const h = createHarness(); t.after(() => h.cleanup());
	h.host.resolveModel = ref => ({ ...capable, ...ref, reasoning: false });
	h.host.authorizeModelOverrides = async choice => assert.equal(choice.thinkingLevel, "off");
	await h.runtime.start(request(h, { model: "test/nonreasoning" }));
	await waitUntil(() => h.factory.opens.length === 1);
	assert.equal(h.factory.opens[0].input.descriptor.thinkingLevel, "off");
});

test("cancellation during approval leaves no durable child", async t => {
	const h = createHarness(); t.after(() => h.cleanup());
	const approval = deferred();
	h.host.authorizeModelOverrides = () => approval.promise;
	const controller = new AbortController();
	const started = h.runtime.start(request(h, { thinkingLevel: "low", signal: controller.signal }));
	controller.abort(); approval.resolve();
	await assert.rejects(started, /aborted/);
	assert.deepEqual(readdirSync(h.childSessions), []);
});

test("tool definitions pass model and effort to the same runtime gate for root and child callers", async () => {
	for (const mode of ["root", "continuable", "one-shot"]) {
		const received = [];
		const runtime = { start: async request => { received.push(request); return { kind: "continuable", subagentId: "child" }; } };
		const tools = createSubagentToolDefinitions(runtime, { getAuthority: () => ({}) }, mode);
		for (const tool of tools.filter(t => ["subagent", "subagent_fork"].includes(t.name))) {
			await tool.execute("call", { description: "test", prompt: "task", model: "test/small", thinking_level: "low" }, undefined, () => {},
				{ sessionManager: {}, model: capable, thinkingLevel: "high", cwd: "/", isProjectTrusted: () => true });
			assert.equal(received.at(-1).model, "test/small");
			assert.equal(received.at(-1).thinkingLevel, "low");
		}
	}
});
