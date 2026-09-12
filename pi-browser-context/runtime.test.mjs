import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import browserContext from "./index.ts";
import { outputArtifactStore } from "../pi-output-budget/extensions/index.ts";
import { ArtifactStore } from "../pi-output-budget/extensions/artifacts.ts";

const tree = Array.from({ length: 200 }, (_, i) => `- listitem [ref=e${i}]: Row ${i}`).join("\n");
const observation = (body, url = "about:blank") => `### Page\n- Page URL: ${url}\n### Snapshot\n\`\`\`yaml\n${body}\n\`\`\`\n### Events\n- Fixture event\n`;
function harness(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-browser-context-"));
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	t.after(() => {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
		rmSync(directory, { recursive: true, force: true });
	});
	const events = new Map(), commands = new Map();
	browserContext({ on(name, fn) { events.set(name, fn); }, registerCommand(name, value) { commands.set(name, value); } });
	let id = 0;
	return {
		events, commands,
		async snapshot(text, options = {}) {
			const event = { toolName: "playwright_browser_snapshot", toolCallId: String(++id), input: {}, isError: false,
				content: [{ type: "text", text }], details: { nativeMetadata: true }, ...options };
			events.get("tool_call")(event);
			return { event, result: await events.get("tool_result")(event) };
		},
	};
}

test("browser middleware retains full observations and changes only repeated snapshot text", async t => {
	const h = harness(t);
	assert.equal((await h.snapshot(observation(tree))).result, undefined);
	const current = observation(tree.replace("Row 100", "Saved 100"));
	const { event, result } = await h.snapshot(current);
	assert.match(result.content[0].text, /Saved 100/);
	assert.doesNotMatch(result.content[0].text, /Row 50/);
	assert.match(result.content[0].text, /### Events\n- Fixture event/);
	assert.deepEqual(event.details, { nativeMetadata: true });
	const id = /Complete current observation: (sha256-[a-f0-9]+)/.exec(result.content[0].text)[1];
	assert.equal(await outputArtifactStore().get(id), current);
});

test("page/scope changes, compaction and branch replacement establish complete baselines", async t => {
	const h = harness(t);
	await h.snapshot(observation(tree));
	assert.equal((await h.snapshot(observation(tree, "https://example.test/"))).result, undefined);
	assert.equal((await h.snapshot(observation(tree), { input: { target: "#dialog" } })).result, undefined);
	for (const event of ["session_compact", "session_tree", "session_start"]) {
		h.events.get(event)();
		assert.equal((await h.snapshot(observation(tree))).result, undefined);
	}
});

test("gateway output receives the same diffs while errors, file links and screenshots stay intact", async t => {
	const h = harness(t);
	const gateway = { toolName: "mcp", input: { tool: "playwright_browser_snapshot", args: "{}" } };
	await h.snapshot(observation(tree), gateway);
	const same = await h.snapshot(observation(tree), gateway);
	assert.match(same.result.content[0].text, /No accessibility changes/);
	assert.equal((await h.snapshot(observation(tree), { isError: true })).result, undefined);
	assert.equal((await h.snapshot("### Snapshot\n- [Snapshot](example.yml)")).result, undefined);
	assert.equal((await h.snapshot("", { content: [{ type: "image", data: "fixture", mimeType: "image/png" }] })).result, undefined);
});

test("a full-mode command and failed archival never silently discard browser evidence", async t => {
	const h = harness(t);
	await h.snapshot(observation(tree));
	t.mock.method(ArtifactStore.prototype, "put", async () => { throw Error("disk fixture"); });
	assert.equal((await h.snapshot(observation(tree))).result, undefined);
	t.mock.restoreAll();
	await h.commands.get("browser-context").handler("full", { ui: { notify() {} } });
	assert.equal((await h.snapshot(observation(tree))).result, undefined);
});

test("a late snapshot completion cannot repopulate a replaced branch baseline", async t => {
	const h = harness(t);
	await h.snapshot(observation(tree));
	let release, started;
	const began = new Promise(resolve => { started = resolve; });
	const realPut = ArtifactStore.prototype.put;
	t.mock.method(ArtifactStore.prototype, "put", async function (value) {
		await new Promise(resolve => { release = resolve; started(); });
		return realPut.call(this, value);
	});
	const pending = h.snapshot(observation(tree.replace("Row 10", "Changed 10")));
	await began;
	h.events.get("session_tree")();
	release();
	assert.equal((await pending).result, undefined);
	t.mock.restoreAll();
	assert.equal((await h.snapshot(observation(tree))).result, undefined);
});
