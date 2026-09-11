import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createIsolatedJiti, patchJitiEvaluator } from "../isolated-jiti.ts";
import { loadChildToolExtensions } from "../../extensions/child-tool-extensions.ts";

const require = createRequire(import.meta.url);
async function fixture(t, files) {
	const root = await mkdtemp(join(tmpdir(), "pi-isolated-jiti-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [name, source] of Object.entries(files)) {
		await mkdir(dirname(join(root, name)), { recursive: true });
		await writeFile(join(root, name), source);
	}
	return root;
}
function metadata(name, path) {
	return { name, description: name, parameters: { type: "object", properties: {} },
		sourceInfo: { path, source: "fixture", scope: "user", origin: "top-level" } };
}
function harness() {
	const tools = new Map(); const handlers = new Map();
	return { tools,
		api: {
			registerTool(tool) { tools.set(tool.name, tool); }, registerFlag() {},
			on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		},
		async emit(name) { for (const handler of handlers.get(name) ?? []) await handler({}, {}); },
	};
}
function prepare(tools, options = {}) {
	return loadChildToolExtensions({ tools, handledToolNames: [], projectTrusted: false,
		signal: new AbortController().signal, ...options });
}

for (const [label, extension, commonjs, packageType] of [
	["TypeScript", "ts", false, "module"],
	["ESM-detected JavaScript", "js", false, undefined],
	["MJS", "mjs", false, "module"],
	["CJS", "cjs", true, "module"],
	["package-type-module JavaScript", "js", false, "module"],
	["CommonJS JavaScript", "js", true, "commonjs"],
]) {
	test(`${label}: cross-entry/transitive state shares within activation, never with root/siblings/reload`, async (t) => {
		const state = "{ calls: 0, inits: 0, stopped: false }";
		const stateSource = commonjs ? `module.exports = ${state};` : `export const state${extension === "ts" ? ": { calls: number; inits: number; stopped: boolean }" : ""} = ${state};`;
		const source = (name) => `${commonjs
			? `const state = require("./middle.${extension}");${name === "a" ? `require("./b.${extension}");` : ""}`
			: `import { state } from "./middle.${extension}";${name === "a" ? `import "./b.${extension}";` : ""}`}
			state.inits++;
			${commonjs ? "module.exports = function(pi)" : "export default function(pi)"} {
				pi.on("session_shutdown", () => { state.stopped = true; });
				pi.registerTool({ name: "${name}", execute: async () => ({ calls: ++state.calls, state }) });
			}`;
		const files = {
			[`state.${extension}`]: stateSource,
			[`middle.${extension}`]: commonjs ? `module.exports = require("./state.${extension}");` : `export { state } from "./state.${extension}";`,
			[`a.${extension}`]: source("a"), [`b.${extension}`]: source("b"),
		};
		if (packageType) files["package.json"] = JSON.stringify({ type: packageType });
		const root = await fixture(t, files);
		const statePath = join(root, `state.${extension}`);
		const native = await import(pathToFileURL(statePath).href);
		const nativeState = commonjs ? native.default : native.state;
		nativeState.calls = 90;
		const originalNativeCache = require.cache[statePath];
		const tools = [metadata("a", join(root, `a.${extension}`)), metadata("b", join(root, `b.${extension}`))];
		const extensions = await prepare(tools);
		assert.equal(extensions.length, 1);
		assert.equal(extensions[0].name, "inherited-tool-providers");
		const { factory } = extensions[0];
		const a = harness(); const b = harness();
		await factory(a.api); await factory(b.api);
		const first = await a.tools.get("a").execute();
		const second = await a.tools.get("b").execute();
		assert.equal(first.calls, 1); assert.equal(second.calls, 2);
		assert.equal(first.state, second.state, "both provider entrypoints see the same exported object");
		assert.equal(second.state.inits, 2, "an entrypoint imported transitively is not evaluated again");
		const sibling = await b.tools.get("a").execute();
		assert.equal(sibling.calls, 1); assert.notEqual(sibling.state, first.state);
		await a.emit("session_shutdown");
		assert.equal(first.state.stopped, true); assert.equal(sibling.state.stopped, false);
		assert.deepEqual(nativeState, { calls: 90, inits: 0, stopped: false });
		assert.equal(require.cache[statePath], originalNativeCache, "root native cache entry is untouched");
		const reload = harness(); await factory(reload.api);
		const restarted = await reload.tools.get("b").execute();
		assert.equal(restarted.calls, 1); assert.equal(restarted.state.inits, 2);
		assert.equal(restarted.state.stopped, false); assert.notEqual(restarted.state, first.state);
	});
}

test("two imports through one isolated Jiti instance share identity; new instances do not", async (t) => {
	const root = await fixture(t, {
		"state.mjs": "export const state = {};",
		"a.mjs": 'export { state } from "./state.mjs";',
		"b.mjs": 'export { state } from "./state.mjs";',
	});
	const a = await createIsolatedJiti(import.meta.url, {});
	const b = await createIsolatedJiti(import.meta.url, {});
	const first = await a.import(join(root, "a.mjs"));
	const second = await a.import(join(root, "b.mjs"));
	assert.equal(first.state, second.state);
	assert.equal(await a.import(join(root, "a.mjs")), first, "cached namespace wrapper identity is stable");
	assert.notEqual((await b.import(join(root, "b.mjs"))).state, first.state);
});

test("static/dynamic CJS default imports retain compatibility and live mutable exports", async (t) => {
	const root = await fixture(t, {
		"state.cjs": "module.exports = { calls: 0 };",
		"entry.mjs": `import state from "./state.cjs";
			export const staticState = state;
			export const dynamicState = (await import("./state.cjs")).default;
			export const mutate = () => ++state.calls;`,
	});
	const jiti = await createIsolatedJiti(import.meta.url, {});
	const module = await jiti.import(join(root, "entry.mjs"));
	assert.ok(module.staticState); assert.equal(module.staticState, module.dynamicState);
	assert.equal(module.mutate(), 1); assert.equal(module.mutate(), 2);
	assert.equal(module.staticState.calls, 2);
});

test("JSON dependencies are graph-local, preserving a native parent's cached object", async (t) => {
	const root = await fixture(t, {
		"state.json": '{ "count": 0 }',
		"entry.cjs": 'module.exports = require("./state.json");',
	});
	const path = join(root, "state.json");
	const native = require(path); const cached = require.cache[path]; native.count = 90;
	const a = await createIsolatedJiti(import.meta.url, {});
	const b = await createIsolatedJiti(import.meta.url, {});
	const one = await a.import(join(root, "entry.cjs"), { default: true });
	const two = await a.import(join(root, "state.json"));
	assert.equal(one, two); one.count++;
	assert.equal(two.count, 1);
	assert.equal((await b.import(join(root, "state.json"))).count, 0);
	assert.equal(native.count, 90); assert.equal(require.cache[path], cached);
});

test("parent flag getter is authoritative, including false and undefined, for factory/hooks/execution", async (t) => {
	const root = await fixture(t, { "provider.ts": `export default pi => {
		pi.registerFlag("read-only", { type: "boolean", default: true });
		const atFactory = pi.getFlag("read-only");
		let atStart;
		pi.on("session_start", () => { atStart = pi.getFlag("read-only"); });
		pi.registerTool({ name: "flags", execute: async () => ({ atFactory, atStart,
			current: pi.getFlag("read-only"), missing: pi.getFlag("missing") }) });
	}` });
	let parentFlag = false; let childReads = 0;
	const [{ factory }] = await prepare([metadata("flags", join(root, "provider.ts"))], {
		getFlag: (name) => name === "read-only" ? parentFlag : undefined,
	});
	const h = harness(); h.api.getFlag = () => { childReads++; return true; };
	await factory(h.api); await h.emit("session_start");
	assert.deepEqual(await h.tools.get("flags").execute(), { atFactory: false, atStart: false, current: false, missing: undefined });
	parentFlag = "explicit-value";
	assert.equal((await h.tools.get("flags").execute()).current, "explicit-value");
	assert.equal(childReads, 0);
	const [{ factory: fallback }] = await prepare([metadata("flags", join(root, "provider.ts"))]);
	const child = harness(); child.api.getFlag = () => true;
	await fallback(child.api); await child.emit("session_start");
	assert.deepEqual(await child.tools.get("flags").execute(), { atFactory: true, atStart: true, current: true, missing: true });
});

test("Jiti version or evaluator-byte drift fails closed", async () => {
	const root = dirname(require.resolve("jiti/package.json"));
	const bytes = await readFile(join(root, "dist", "jiti.cjs"));
	assert.match(patchJitiEvaluator(bytes, "2.7.0"), /S=!0/);
	assert.throws(() => patchJitiEvaluator(bytes, "2.7.1"), /requires jiti@2\.7\.0/);
	assert.throws(() => patchJitiEvaluator(Buffer.concat([bytes, Buffer.from("\n")]), "2.7.0"), /source hash differs/);
});

test("data URL and unknown-extension native escape paths fail explicitly", async (t) => {
	const root = await fixture(t, { "entry.cjs": 'module.exports = require("./state.unrecognized");',
		"state.unrecognized": "module.exports = {};" });
	const jiti = await createIsolatedJiti(import.meta.url, {});
	await assert.rejects(jiti.import("data:text/javascript,export default {}"), /cannot import data:/);
	await assert.rejects(jiti.import(join(root, "entry.cjs")), /Unsupported isolated child module extension/);
});
