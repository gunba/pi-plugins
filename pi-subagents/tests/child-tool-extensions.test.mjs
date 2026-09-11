import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai/compat";
import * as typebox from "typebox";
import { createJiti } from "jiti";
import { loadChildToolExtensions } from "../extensions/child-tool-extensions.ts";

async function fixture(t, files = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-child-tool-extensions-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [name, text] of Object.entries(files)) {
		await mkdir(join(root, name, ".."), { recursive: true });
		await writeFile(join(root, name), text);
	}
	return root;
}

function tool(name, path, overrides = {}) {
	return { name, description: `Fixture ${name}`, parameters: typebox.Type.Object({}),
		sourceInfo: { path, source: "fixture", scope: "user", origin: "top-level", ...overrides } };
}

function load(tools, options = {}) {
	return loadChildToolExtensions({ tools, handledToolNames: [], signal: new AbortController().signal,
		projectTrusted: false, ...options });
}

function harness() {
	const tools = new Map(); const hooks = new Map(); const events = sdk.createEventBus();
	const api = {
		events,
		registerTool(definition) { tools.set(definition.name, definition); },
		on(name, callback) { const list = hooks.get(name) ?? []; list.push(callback); hooks.set(name, list); },
		registerCommand() {}, registerFlag() {}, registerShortcut() {},
	};
	return { api, tools, hooks,
		async emit(name, event = {}, ctx = {}) { for (const callback of hooks.get(name) ?? []) await callback(event, ctx); } };
}

async function loaderFor(root, extensionFactories, eventBus = sdk.createEventBus()) {
	const settingsManager = sdk.SettingsManager.inMemory({ packages: [], extensions: [] });
	const loader = new sdk.DefaultResourceLoader({
		cwd: root, agentDir: join(root, "agent"), settingsManager, eventBus, extensionFactories,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	return { loader, settingsManager };
}

const simpleProvider = (names) => `
export default function(pi) {
	for (const name of ${JSON.stringify(names)}) pi.registerTool({
		name, label: name, description: name, parameters: { type: "object", properties: {} },
		async execute() { return { content: [{ type: "text", text: name }], details: {} }; }
	});
}`;

const model = { id: "child-model", name: "Offline child model", provider: "offline-fixture", api: "openai-completions",
	baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

test("arbitrary provider tools run with real child cwd/model/session and retain lifecycle/policy hooks", { timeout: 20000 }, async (t) => {
	const root = await fixture(t, { "provider.ts": `
import { Type } from "@sinclair/typebox";
export default function(pi) {
	let started;
	pi.on("session_start", (_event, ctx) => { started = ctx.sessionManager.getSessionId(); });
	pi.on("session_shutdown", (_event, ctx) => { pi.events.emit("fixture:shutdown", ctx.sessionManager.getSessionId()); });
	pi.on("tool_call", event => event.toolName === "web_search" ? { block: true, reason: "child policy" } : undefined);
	for (const name of ["web_search", "custom.project_lookup"]) pi.registerTool({
		name, label: name, description: name, parameters: Type.Object({}),
		async execute(_id, _args, _signal, _onUpdate, ctx) {
			pi.appendEntry("child-tool-fixture", { name });
			const details = { cwd: ctx.cwd, model: ctx.model?.id, session: ctx.sessionManager.getSessionId(), started };
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		}
	});
}` });
	const tools = [tool("web_search", join(root, "provider.ts")), tool("custom.project_lookup", join(root, "provider.ts"))];
	// Metadata contains no parent execute functions; inheritance cannot copy one.
	const factories = await load(tools);
	assert.equal(factories.length, 1);
	const bus = sdk.createEventBus(); const shutdown = [];
	bus.on("fixture:shutdown", (id) => shutdown.push(id));
	const { loader, settingsManager } = await loaderFor(root, factories, bus);
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = sdk.SessionManager.inMemory(root, { id: "child-tool-session" });
	const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(),
		modelsPath: join(root, "models.json"), modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false });
	const { session } = await sdk.createAgentSession({ cwd: root, agentDir: join(root, "agent"), model,
		modelRuntime, sessionManager: manager, resourceLoader: loader, settingsManager, tools: tools.map((item) => item.name) });
	t.after(() => session.dispose());
	await session.bindExtensions({ mode: "rpc" });
	assert.deepEqual(session.agent.state.tools.map((item) => item.name).sort(), tools.map((item) => item.name).sort());
	const result = await session.agent.state.tools.find((item) => item.name === "custom.project_lookup").execute("call", {});
	assert.deepEqual(result.details, { cwd: root, model: model.id, session: "child-tool-session", started: "child-tool-session" });
	assert.equal(manager.getBranch().filter((entry) => entry.customType === "child-tool-fixture").length, 1);
	assert.deepEqual(await session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "web_search", toolCallId: "blocked", input: {} }),
		{ block: true, reason: "child policy" });
	await session.extensionRunner.emit({ type: "session_shutdown" });
	assert.deepEqual(shutdown, ["child-tool-session"]);
});

test("source ownership filters overridden/inactive extra and late hook registrations", async (t) => {
	const root = await fixture(t, {
		"a.ts": `${simpleProvider(["custom_a", "web_search", "unowned_extra", "todo_write"])}\n`,
		"b.ts": `export default function(pi) {
			const register = name => pi.registerTool({ name, label: name, description: "winner-b", parameters: { type: "object" }, execute: async () => ({content: [], details: {}}) });
			register("web_search");
			pi.on("session_start", () => { register("web_search"); register("custom_a"); register("late_extra"); });
		}`,
	});
	const factories = await load([tool("custom_a", join(root, "a.ts")), tool("web_search", join(root, "b.ts")),
		tool("todo_write", join(root, "a.ts"))], { handledToolNames: new Set(["todo_write"]) });
	assert.equal(factories.length, 1);
	const h = harness();
	for (const { factory } of factories) await factory(h.api);
	await h.emit("session_start");
	assert.deepEqual([...h.tools.keys()].sort(), ["custom_a", "web_search"]);
	assert.equal(h.tools.get("web_search").description, "winner-b");
	assert.equal(h.tools.get("custom_a").description, "custom_a");
});

test("dependency state is shared within one graph but isolated from native root, siblings and reactivations", async (t) => {
	const root = await fixture(t, {
		"state.mjs": `export const state = { calls: 0, stopped: false }; export const stop = () => { state.stopped = true; };`,
		"left.ts": `export { state, stop } from "./state.mjs";`,
		"right.ts": `export { state } from "./state.mjs";`,
		"provider.ts": `import { state, stop } from "./left.ts"; import { state as other } from "./right.ts";
			export default function(pi) {
				pi.on("session_shutdown", stop);
				pi.registerTool({ name: "module_state", label: "state", description: "state", parameters: { type: "object" },
					execute: async () => ({ content: [], details: { calls: ++state.calls, stopped: state.stopped, same: state === other } }) });
			}`,
	});
	const nativeRoot = await import(pathToFileURL(join(root, "state.mjs")).href);
	nativeRoot.state.calls = 90;
	const [{ factory }] = await load([tool("module_state", join(root, "provider.ts"))]);
	const a = harness(); const b = harness();
	await factory(a.api); await factory(b.api);
	const execute = (h) => h.tools.get("module_state").execute();
	assert.deepEqual((await execute(a)).details, { calls: 1, stopped: false, same: true });
	assert.equal((await execute(a)).details.calls, 2);
	assert.deepEqual((await execute(b)).details, { calls: 1, stopped: false, same: true });
	await a.emit("session_shutdown");
	assert.equal((await execute(a)).details.stopped, true);
	assert.equal((await execute(b)).details.stopped, false);
	assert.deepEqual(nativeRoot.state, { calls: 90, stopped: false });
	const reload = harness(); await factory(reload.api);
	assert.deepEqual((await execute(reload)).details, { calls: 1, stopped: false, same: true });
});

test("CommonJS provider dependencies are isolated too", async (t) => {
	const root = await fixture(t, {
		"state.cjs": `module.exports = { count: 0 };`,
		"provider.cjs": `const state = require("./state.cjs"); module.exports = pi => pi.registerTool({name: "cjs_tool", execute: async () => ++state.count});`,
	});
	const [{ factory }] = await load([tool("cjs_tool", join(root, "provider.cjs"))]);
	const a = harness(); const b = harness(); await factory(a.api); await factory(b.api);
	assert.equal(await a.tools.get("cjs_tool").execute(), 1);
	assert.equal(await a.tools.get("cjs_tool").execute(), 2);
	assert.equal(await b.tools.get("cjs_tool").execute(), 1);
});

test("native framework identities, legacy aliases, and pi-ai compat routes remain shared", async (t) => {
	const resolver = createJiti(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const [typebox, compile, value, ai, oauth, providers, core, tui] = await Promise.all([
		"typebox", "typebox/compile", "typebox/value", "@earendil-works/pi-ai/compat",
		"@earendil-works/pi-ai/oauth", "@earendil-works/pi-ai/providers/all", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui",
	].map((name) => import(resolver.esmResolve(name))));
	const modules = {
		"typebox": typebox, "typebox/compile": compile, "typebox/value": value,
		"@sinclair/typebox": typebox, "@sinclair/typebox/compile": compile, "@sinclair/typebox/value": value,
	};
	for (const scope of ["@earendil-works", "@mariozechner"]) Object.assign(modules, {
		[`${scope}/pi-coding-agent`]: sdk, [`${scope}/pi-ai`]: ai, [`${scope}/pi-ai/compat`]: ai,
		[`${scope}/pi-ai/oauth`]: oauth, [`${scope}/pi-ai/providers/all`]: providers,
		[`${scope}/pi-agent-core`]: core, [`${scope}/pi-tui`]: tui,
	});
	const imports = Object.keys(modules).map((id, index) => `import * as m${index} from ${JSON.stringify(id)};`).join("\n");
	const root = await fixture(t, { "provider.ts": `${imports}\nexport default function(pi) { pi.events.emit("modules", [${Object.keys(modules).map((_, i) => `m${i}`).join(",")}]); }` });
	const h = harness(); let received;
	h.api.events.on("modules", (modules) => { received = modules; });
	const [{ factory }] = await load([tool("identity_fixture", join(root, "provider.ts"))]);
	await factory(h.api);
	Object.values(modules).forEach((expected, index) => {
		const symbols = Object.keys(expected);
		for (const symbol of symbols) assert.equal(received[index][symbol], expected[symbol], `${Object.keys(modules)[index]}.${symbol}`);
	});
	assert.equal(typeof received[Object.keys(modules).indexOf("@earendil-works/pi-ai")].getModel, "function", "pi-ai root must expose compat exports");
});

test("builtin ownership and handled names skip loading, not a maintained name whitelist", async (t) => {
	assert.deepEqual(await load([
		tool("novel_builtin", "<builtin>", { source: "builtin" }),
		{ name: "subagent" }, { name: "todo_write", sourceInfo: { path: "<inline:todo>" } },
	], { handledToolNames: (function* () { yield "subagent"; yield "todo_write"; })() }), []);
	const root = await fixture(t, { "override.ts": simpleProvider(["bash"]) });
	const [{ factory }] = await load([tool("bash", join(root, "override.ts"))]);
	const h = harness(); await factory(h.api);
	assert.ok(h.tools.has("bash"), "an extension-owned builtin-name override is not builtin ownership");
});

test("missing/synthetic/relative source metadata is diagnosed instead of silently dropping tools", async () => {
	for (const item of [
		{ name: "missing_source" }, tool("inline_tool", "<inline:custom>"),
		tool("synthetic_tool", "<custom>"), tool("relative_tool", "provider.ts"),
		tool("empty_source", ""),
	]) {
		await assert.rejects(load([item]), (error) => error.message.includes(item.name) && /sourceInfo|synthetic|inline/.test(error.message));
	}
});

test("missing files, directories and ambiguous owners fail clearly before activation", async (t) => {
	const root = await fixture(t, { "a.ts": simpleProvider(["duplicate"]), "b.ts": simpleProvider(["duplicate"]) });
	await assert.rejects(load([tool("missing_file", join(root, "not-there.ts"))]), /missing_file.*cannot read extension source/);
	await assert.rejects(load([tool("directory_tool", root)]), /directory_tool.*not a file/);
	await assert.rejects(load([tool("duplicate", join(root, "a.ts")), tool("duplicate", join(root, "b.ts"))]), /duplicate.*multiple source files/);
	assert.equal((await load([tool("duplicate", join(root, "a.ts")), tool("duplicate", join(root, "a.ts"))])).length, 1);
});

test("project trust is enforced for every source before module evaluation", async (t) => {
	const root = await fixture(t, { "provider.ts": simpleProvider(["project_tool"]) });
	const metadata = tool("project_tool", join(root, "provider.ts"), { scope: "project" });
	await assert.rejects(load([metadata]), /project_tool.*project trust is required/);
	const [{ factory }] = await load([metadata], { projectTrusted: true });
	const h = harness(); await factory(h.api); assert.ok(h.tools.has("project_tool"));
	assert.equal((await load([tool("user_tool", join(root, "provider.ts"), { scope: "user" })])).length, 1);
});

test("source errors identify tools and path; non-factory modules and thrown factories reject", async (t) => {
	const root = await fixture(t, { "invalid.ts": "export const noFactory = true;", "throws.ts": "export default () => { throw new Error('fixture failure'); };" });
	for (const [file, pattern] of [["invalid.ts", /default-export a factory/], ["throws.ts", /fixture failure/]]) {
		const [{ factory }] = await load([tool("broken_tool", join(root, file))]);
		await assert.rejects(factory(harness().api), (error) => error.message.includes("broken_tool") && error.message.includes(file) && pattern.test(error.message));
	}
});

test("abort before validation or activation preserves the original reason and runs no factory", async (t) => {
	const abort = new AbortController(); const reason = new Error("cancel fixture"); abort.abort(reason);
	await assert.rejects(load([], { signal: abort.signal }), (error) => error === reason);
	const root = await fixture(t, { "provider.ts": "throw new Error('module should not run');" });
	const pending = new AbortController();
	const [{ factory }] = await load([tool("abort_tool", join(root, "provider.ts"))], { signal: pending.signal });
	pending.abort(reason);
	await assert.rejects(factory(harness().api), (error) => error === reason);
});

test("abort during async initialization rejects and the real SDK rolls back registrations and subscriptions", async (t) => {
	const root = await fixture(t, { "provider.ts": `export default async function(pi) {
		pi.events.on("leak", () => pi.events.emit("leaked"));
		pi.registerTool({ name: "abort_tool", parameters: { type: "object" }, execute: async () => ({ content: [], details: {} }) });
		await new Promise(resolve => pi.events.emit("abort-fixture", resolve));
	}` });
	const controller = new AbortController(); const bus = sdk.createEventBus();
	let leaks = 0; bus.on("leaked", () => leaks++);
	bus.on("abort-fixture", (resume) => { controller.abort(new Error("abort while loading")); resume(); });
	const factories = await load([tool("abort_tool", join(root, "provider.ts"))], { signal: controller.signal });
	const { loader } = await loaderFor(root, factories, bus);
	assert.equal(loader.getExtensions().extensions.length, 0);
	assert.equal(loader.getExtensions().errors.length, 1);
	assert.match(loader.getExtensions().errors[0].error, /abort while loading/);
	bus.emit("leak"); assert.equal(leaks, 0);
});


test("helper also works when imported through the real SDK/Jiti disk-extension loader", async (t) => {
	const root = await fixture(t, { "provider.mjs": `
		import { Type } from "@sinclair/typebox";
		export default pi => {
			pi.registerFlag("read-only", { type: "boolean", default: true });
			pi.registerTool({ name: "disk_loaded", label: "disk", description: "disk", parameters: Type.Object({}),
				execute: async () => ({ content: [], details: { flag: pi.getFlag("read-only") } }) });
		};` });
	const helper = new URL("../extensions/child-tool-extensions.ts", import.meta.url).href;
	await writeFile(join(root, "outer.ts"), `
		import { loadChildToolExtensions } from ${JSON.stringify(helper)};
		export default async pi => {
			const extensions = await loadChildToolExtensions({
				tools: ${JSON.stringify([tool("disk_loaded", join(root, "provider.mjs"))])},
				handledToolNames: [], signal: new AbortController().signal,
				projectTrusted: false, getFlag: () => false,
			});
			for (const extension of extensions) await extension.factory(pi);
		}`);
	const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"),
		settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [] }),
		additionalExtensionPaths: [join(root, "outer.ts")],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const registered = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.values()]);
	assert.equal(registered.length, 1); assert.equal(registered[0].definition.name, "disk_loaded");
	assert.deepEqual((await registered[0].definition.execute()).details, { flag: false });
});
