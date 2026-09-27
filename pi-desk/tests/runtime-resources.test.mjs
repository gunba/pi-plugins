import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resourceSettings } from "../src/host/runtime-resources.ts";
import { loadChildToolExtensions } from "../../pi-subagents/extensions/child-tool-extensions.ts";

const provider = (name, value) => `import {Type} from "typebox";
export default pi => pi.registerTool({
	name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)}, description: "Fixture provider",
	parameters: Type.Object({}), execute: async () => ({content: [{type: "text", text: ${JSON.stringify(value)}}], details: {}})
});`;
async function child(tools) {
	const factories = await loadChildToolExtensions({ tools, handledToolNames: [], signal: new AbortController().signal, projectTrusted: false });
	const registered = new Map();
	const api = { registerTool: tool => registered.set(tool.name, tool), on() {}, events: { on() {}, emit() {} } };
	for (const extension of factories) await (typeof extension === "function" ? extension : extension.factory)(api);
	return registered;
}

test("native discovery pins first-party paths for late children and reloads without changing saved settings or other packages", async t => {
	const base = await mkdtemp(join(tmpdir(), "desk-runtime-resources-"));
	const sessions = [], previousOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	t.after(async () => {
		for (const session of sessions) await session.dispose();
		await rm(base, { recursive: true, force: true });
		if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
	});
	const agentDir = join(base, "agent"), source = join(base, "installed"), pinned = join(base, "pinned"), other = join(base, "other");
	for (const directory of [agentDir, source, other, join(base, ".pi")]) await mkdir(directory, { recursive: true });
	await writeFile(join(source, "package.json"), JSON.stringify({ name: "pi-plugins", pi: { extensions: ["owned.ts", "disabled.ts"] } }));
	await writeFile(join(source, "owned.ts"), provider("owned", "old first party"));
	await writeFile(join(source, "disabled.ts"), provider("disabled", "must remain disabled"));
	await cp(source, pinned, { recursive: true });
	const personal = join(source, ".pi", "personal.ts");
	await mkdir(join(source, ".pi"));
	await writeFile(personal, provider("personal", "not part of the package snapshot"));
	await writeFile(join(other, "package.json"), JSON.stringify({ pi: { extensions: ["index.ts"] } }));
	await writeFile(join(other, "index.ts"), provider("third_party", "old third party"));
	const settingsPath = join(agentDir, "settings.json");
	const config = { packages: [{ source, extensions: ["owned.ts"] }, other], extensions: [personal] };
	await writeFile(settingsPath, JSON.stringify(config));
	await writeFile(join(base, ".pi", "settings.json"), JSON.stringify({ extensions: ["./untrusted.ts"] }));
	await writeFile(join(base, ".pi", "untrusted.ts"), provider("untrusted", "must not execute"));

	const settings = SettingsManager.create(base, agentDir, { projectTrusted: false });
	const explicit = resourceSettings(SettingsManager.inMemory({ extensions: [join(source, "owned.ts"), personal],
		prompts: [join(source, ".pi", "*.md"), join(source, "*.md")] }), base, agentDir, { source, root: pinned }).getGlobalSettings();
	assert.deepEqual(explicit.extensions, [join(pinned, "owned.ts"), personal]);
	assert.deepEqual(explicit.prompts, [join(source, ".pi", "*.md"), join(pinned, "*.md")]);
	const normal = new DefaultResourceLoader({ cwd: base, agentDir, settingsManager: settings });
	const managed = new DefaultResourceLoader({ cwd: base, agentDir, settingsManager: resourceSettings(settings, base, agentDir, { source, root: pinned }) });
	await normal.reload({ resolveProjectTrust: async () => false });
	await managed.reload({ resolveProjectTrust: async () => false });
	assert.deepEqual(normal.getExtensions().errors, []);
	assert.deepEqual(managed.getExtensions().errors, []);
	const open = async loader => {
		const result = await createAgentSession({ cwd: base, agentDir, settingsManager: settings, resourceLoader: loader,
			sessionManager: SessionManager.inMemory(base) });
		sessions.push(result.session);
		await result.session.bindExtensions({ mode: "rpc" });
		return result.session;
	};
	const original = await open(normal), current = await open(managed);
	const originalTool = original.getAllTools().filter(tool => tool.name === "owned");
	const pinnedTool = current.getAllTools().filter(tool => tool.name === "owned");
	assert.equal(originalTool.length, 1, JSON.stringify(normal.getExtensions().extensions.map(e => ({ path: e.path, tools: [...e.tools.keys()] }))));
	assert.equal(pinnedTool.length, 1);
	assert.equal(pinnedTool[0].sourceInfo.path, join(pinned, "owned.ts"));
	assert.equal((await current.getToolDefinition("personal").execute()).content[0].text, "not part of the package snapshot");
	assert.equal(current.getAllTools().some(tool => ["disabled", "untrusted"].includes(tool.name)), false);

	// The old installation path disappears in the goal/todo → plan cutover.
	await rm(join(source, "owned.ts"));
	await writeFile(join(source, "package.json"), JSON.stringify({ name: "pi-plugins", pi: { extensions: ["replacement.ts"] } }));
	await writeFile(join(source, "replacement.ts"), provider("replacement", "new first party"));
	await writeFile(join(other, "index.ts"), provider("third_party", "new third party"));
	await assert.rejects(child(originalTool), /Cannot inherit child tool provider/);
	const inherited = await child(pinnedTool);
	assert.equal((await inherited.get("owned").execute()).content[0].text, "old first party");

	await managed.reload({ resolveProjectTrust: async () => false });
	assert.deepEqual(managed.getExtensions().errors, []);
	const reloaded = await open(managed);
	assert.equal((await reloaded.getToolDefinition("owned").execute()).content[0].text, "old first party");
	assert.equal((await reloaded.getToolDefinition("third_party").execute()).content[0].text, "new third party");
	assert.equal(reloaded.getAllTools().some(tool => tool.name === "replacement"), false);
	settings.setDefaultThinkingLevel("low"); await settings.flush();
	assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).packages, config.packages);
	assert.equal(settings.isProjectTrusted(), false);
});
