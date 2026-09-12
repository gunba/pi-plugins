import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import contextLimit, { parseLimit, withReserve, writeReserve } from "./index.ts";

test("token counts accept decimal k/m and reject unsafe or impossible thresholds", () => {
	for (const value of ["200k", "200K", "200000", "0.2m", " 200 k "]) assert.equal(parseLimit(value, 272000, 20000), 200000);
	for (const value of ["", "-1", "NaN", "Infinity", "20001.1", "1e5", "20k", "272k", "500k"]) {
		assert.throws(() => parseLimit(value, 272000, 20000));
	}
});

test("the native settings loader applies the new reserve on reload without altering other settings", async t => {
	const directory = mkdtempSync(join(tmpdir(), "pi-context-limit-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "settings.json");
	writeFileSync(path, JSON.stringify({ theme: "test", compaction: { reserveTokens: 72000, keepRecentTokens: 20000 } }));
	const settings = SettingsManager.create(directory, directory, { projectTrusted: false });
	assert.equal(settings.getCompactionReserveTokens(), 72000);
	writeReserve(directory, 112000);
	assert.equal(settings.getCompactionReserveTokens(), 72000);
	await settings.reload();
	assert.equal(settings.getCompactionReserveTokens(), 112000);
	assert.equal(settings.getCompactionKeepRecentTokens(), 20000);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).theme, "test");
	mkdirSync(`${path}.lock`);
	assert.throws(() => writeReserve(directory, 100000), { code: "EEXIST" });
	assert.equal(JSON.parse(readFileSync(path, "utf8")).compaction.reserveTokens, 112000);
});

test("the command waits for idle and invokes the supported extension reload", async t => {
	const directory = mkdtempSync(join(tmpdir(), "pi-context-command-"));
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	t.after(() => {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
		rmSync(directory, { recursive: true, force: true });
	});
	writeFileSync(join(directory, "settings.json"), '{"compaction":{"reserveTokens":72000,"keepRecentTokens":20000}}');
	let command;
	const calls = [];
	contextLimit({ registerCommand(name, value) { assert.equal(name, "context-limit"); command = value; } });
	const ctx = {
		cwd: directory, model: { name: "Fixture", contextWindow: 272000 }, isProjectTrusted: () => false,
		async waitForIdle() { calls.push("idle"); }, async reload() { calls.push("reload"); },
		ui: { notify(message, level) { calls.push(level); assert.equal(level, "info", message); } },
	};
	await command.handler("160k", ctx);
	assert.deepEqual(calls, ["idle", "info", "reload"]);
	assert.equal(JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")).compaction.reserveTokens, 112000);
});

test("reserve updates preserve unrelated settings and native compaction options", () => {
	const source = { theme: "test", compaction: { enabled: false, keepRecentTokens: 21000, reserveTokens: 72000 }, futureField: { x: true } };
	const changed = JSON.parse(withReserve(JSON.stringify(source), 112000));
	assert.deepEqual(changed, { ...source, compaction: { ...source.compaction, reserveTokens: 112000 } });
	assert.deepEqual(JSON.parse(withReserve(undefined, 72000)), { compaction: { reserveTokens: 72000 } });
	for (const bad of ["not json", "[]", "null", '{"compaction":null}', '{"compaction":3}']) assert.throws(() => withReserve(bad, 1000));
});
