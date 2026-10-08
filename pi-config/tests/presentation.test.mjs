import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigPresentation } from "../presentation.ts";
import { resourceInventory } from "../../pi-ui/resources.ts";

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-config-presentation-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const global = join(directory, "global.json"), project = join(directory, "project.json"), skill = join(directory, "SKILL.md");
	writeFileSync(global, JSON.stringify({ theme: "dark", httpProxy: "https://fixture:secret@invalid.test", futureOption: 42 }));
	writeFileSync(project, JSON.stringify({ theme: "light" }));
	writeFileSync(skill, "# Example skill\n");
	let view, callbacks, answer;
	const documents = [
		{ id: "global", title: "Global settings", path: global, kind: "settings", scope: "global", format: "json", exists: true },
		{ id: "project", title: "Project settings", path: project, kind: "settings", scope: "project", format: "json", exists: true },
		{ id: "skill", title: "Example", path: skill, kind: "skill", scope: "package", format: "markdown", exists: true, loaded: true, readonly: true },
	];
	const controller = new ConfigPresentation({
		publish(_id, next, actions) { view = next; callbacks = actions; }, open() {},
		async request(form) { return answer?.(form) ?? null; },
	}, {
		discover: () => documents, nativeResources: true,
		effective: () => ({ theme: "light", futureOption: 42, httpProxy: "https://fixture:secret@invalid.test" }),
		reference: () => [{ key: "theme", label: "Theme", type: "string", description: "Pi theme", defaultValue: "dark" }],
		validate: (entry, text) => { if (entry.format === "json") JSON.parse(text); },
		insert: (text, key, value) => JSON.stringify({ ...JSON.parse(text), [key]: value }),
	}, () => {});
	return { directory, global, project, skill, controller, get view() { return view; }, invoke: (id, value) => callbacks[id](value), answer: value => answer = value };
}

test("Desk settings include effective and unknown keys, saved scopes and protected previews", async t => {
	const f = fixture(t);
	assert.equal(f.view.data.loaded, false);
	await f.invoke("browse", null);
	assert.equal(f.view.kind, "configuration");
	assert.equal(f.view.data.nativeResources, true);
	assert.deepEqual(f.view.data.settings.find(row => row.key === "futureOption"), {
		key: "futureOption", label: "futureOption", type: "number", description: "Present in this session or its saved settings.", choices: undefined,
		value: "42", defaultValue: undefined, global: "42", project: undefined,
	});
	const theme = f.view.data.settings.find(row => row.key === "theme");
	assert.equal(theme.value, '"light"'); assert.equal(theme.global, '"dark"'); assert.equal(theme.project, '"light"');
	assert.equal(JSON.stringify(f.view).includes("fixture:secret"), false);
	await f.invoke("open", "global");
	assert.match(f.view.data.selected.preview, /host-only:/);
	assert.equal(f.view.data.selected.protectedCount, 1);
	f.answer(form => ({ kind: "freeform", text: form.value.replace('"dark"', '"new-theme"') }));
	await f.invoke("edit", null);
	const saved = JSON.parse(readFileSync(f.global, "utf8"));
	assert.equal(saved.theme, "new-theme"); assert.equal(saved.httpProxy, "https://fixture:secret@invalid.test");
	await f.invoke("open", "skill");
	assert.equal(f.view.data.selected.file.readonly, true);
	assert.equal(f.view.actions.some(action => action.id === "edit"), false);
	assert.equal(readFileSync(f.skill, "utf8"), "# Example skill\n");
});

test("configuration actions keep their file and branch fences", async t => {
	const f = fixture(t);
	await f.invoke("browse", null);
	await assert.rejects(f.invoke("open", join(f.directory, "unlisted")), /no longer in the resource inventory/);
	await f.invoke("open", "project");
	f.answer(form => { writeFileSync(f.project, '{"concurrent":true}'); return { kind: "freeform", text: form.value }; });
	await assert.rejects(f.invoke("edit", null), /changed while/);
	assert.equal(readFileSync(f.project, "utf8"), '{"concurrent":true}');
	const invoke = f.invoke.bind(f);
	// Keep a copy of the published callback before retirement.
	let held;
	f.answer(() => new Promise(resolve => { held = resolve; }));
	await f.invoke("reopen", null);
	const pending = invoke("edit", null);
	f.controller.close(); held({ kind: "freeform", text: "{}" });
	await assert.rejects(pending, /previous session or branch/);
	assert.equal(readFileSync(f.project, "utf8"), '{"concurrent":true}');
});

test("native inventory includes commandless and built-in extensions with managed files read-only", t => {
	const f = fixture(t), extension = join(f.directory, "extension.js"); writeFileSync(extension, "export default () => {};\n");
	const resources = resourceInventory({
		getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPromptSource: () => undefined, getAppendSystemPromptSources: () => [],
		getSkills: () => ({ skills: [{ name: "Example", filePath: f.skill, description: "Fixture" }] }),
		getPrompts: () => ({ prompts: [] }),
		getExtensions: () => ({ extensions: [{ path: extension }, { path: "builtin:mcp" }], errors: [] }),
	}, [f.directory]);
	assert.deepEqual(resources.map(item => [item.kind, item.path, item.loaded, item.readonly]), [
		["skill", f.skill, true, true], ["extension", extension, true, true], ["extension", "builtin:mcp", true, true],
	]);
});
