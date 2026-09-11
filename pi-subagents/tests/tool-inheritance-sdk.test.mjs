import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Type } from "typebox";
import { AssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PiSdkDriverFactory } from "../extensions/pi-sdk-driver.ts";

const SEARCH_SOURCE = fileURLToPath(new URL("../../pi-web-search/extensions/web-search.ts", import.meta.url));
const ZERO_USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = (id) => ({ id, name: id, api: "openai-codex-responses", provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api", reasoning: false, input: ["text"],
	contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const MODELS = [model("root-codex-fixture"), model("child-codex-fixture"), model("grandchild-codex-fixture")];
const JWT = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture-account" } })).toString("base64url")}.fixture`;
const text = (content) => typeof content === "string" ? content : (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const promptTool = (name, args = {}) => `fixture-tool:${JSON.stringify({ name, args })}`;

function providerFixture(respond) {
	const stream = (selectedModel, context, options) => {
		const events = new AssistantMessageEventStream();
		queueMicrotask(() => {
			try {
				const result = respond(selectedModel, context, options);
				const message = { role: "assistant", api: selectedModel.api, provider: selectedModel.provider, model: selectedModel.id,
					usage: structuredClone(ZERO_USAGE), timestamp: Date.now(), ...result };
				events.push({ type: "done", reason: message.stopReason, message });
			} catch (error) {
				const message = { role: "assistant", api: selectedModel.api, provider: selectedModel.provider, model: selectedModel.id,
					content: [], stopReason: "error", errorMessage: String(error), usage: structuredClone(ZERO_USAGE), timestamp: Date.now() };
				events.push({ type: "error", reason: "error", error: message });
			}
		});
		return events;
	};
	return { id: "openai-codex", name: "Offline Codex fixture", baseUrl: MODELS[0].baseUrl,
		auth: { apiKey: { name: "Offline only", async resolve() { return { auth: { apiKey: JWT }, source: "offline fixture" }; } } },
		getModels: () => MODELS, stream, streamSimple: stream };
}

function providerSource(auditPath) {
	return `import { appendFileSync } from "node:fs";
import { Type } from "typebox";
import { state } from "./provider-state.mjs";
export default function(pi) {
	pi.registerFlag("allow-restricted", { type: "boolean", default: true });
	const factoryFlag = pi.getFlag("allow-restricted");
	let started;
	const localPolicy = (_event, ctx) => {
		if (ctx.model?.id !== "root-codex-fixture") pi.setActiveTools(pi.getActiveTools().filter(name => name !== "local_policy_tool"));
	};
	pi.on("session_start", (_event, ctx) => { started = ctx.sessionManager.getSessionId(); });
	pi.on("session_start", localPolicy);
	pi.on("tool_call", event => event.toolName === "restricted_action" && pi.getFlag("allow-restricted") === false
		? { block: true, reason: "fixture permission retained: parent flag is false" } : undefined);
	pi.on("session_shutdown", (_event, ctx) => {
		state.stopped = true;
		appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify({ kind: "shutdown", id: ctx.sessionManager.getSessionId(), calls: state.calls }) + "\\n");
	});
	for (const name of ["custom_inventory", "restricted_action", "newly_enabled", "local_policy_tool"]) pi.registerTool({
		name, label: name, description: "Offline source-owned integration fixture", parameters: Type.Object({}),
		async execute(_id, _args, _signal, _update, ctx) {
			const details = { name, cwd: ctx.cwd, model: ctx.model?.id, id: ctx.sessionManager.getSessionId(), started,
				calls: ++state.calls, stopped: state.stopped, factoryFlag, flag: pi.getFlag("allow-restricted"),
				source: pi.getAllTools().find(tool => tool.name === name)?.sourceInfo.path };
			pi.appendEntry("tool-inheritance/executed", details);
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		}
	});
}`;
}

async function integration(t, { search = false, initialActive = ["custom_inventory", "restricted_action"] } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-tool-inheritance-sdk-"));
	const agentDir = join(directory, "agent"); const rootCwd = join(directory, "root-work");
	await mkdir(agentDir); await mkdir(rootCwd);
	const priorDir = process.env.PI_CODING_AGENT_DIR;
	const priorOffline = process.env.PI_OFFLINE;
	const priorFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	const children = []; let rootSession;
	t.after(async () => {
		try {
			for (const child of children) await child.driver.dispose();
			await rootSession?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			rootSession?.dispose();
			globalThis.fetch = priorFetch;
			if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorDir;
			if (priorOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = priorOffline;
			await rm(directory, { recursive: true, force: true });
		}
	});
	const settings = { packages: [], extensions: [], compaction: { enabled: false }, retry: { enabled: false } };
	await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
	const requests = [];
	globalThis.fetch = async (url, init) => {
		assert.equal(String(url), "https://chatgpt.com/backend-api/codex/alpha/search", "all network calls must hit this fake search handler");
		assert.equal(init?.method, "POST");
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), `Bearer ${JWT}`);
		assert.equal(headers.get("chatgpt-account-id"), "offline-fixture-account");
		requests.push({ url: String(url), body: JSON.parse(init.body) });
		return Response.json({ output: "OFFLINE SEARCH RESULT", results: [{ url: "https://example.invalid/fixture" }] });
	};
	const auditPath = join(directory, "shutdown.jsonl");
	const fixturePath = join(directory, "provider.ts");
	await writeFile(join(directory, "provider-state.mjs"), "export const state = { calls: 0, stopped: false };\n");
	await writeFile(fixturePath, providerSource(auditPath));
	const observations = []; let serial = 0; let beforeToolResponse;
	const respond = (selected, context, options) => {
		assert.ok(++serial < 80, "fixture cannot enter an unbounded model/tool loop");
		const latest = context.messages.at(-1);
		const available = (context.tools ?? []).map((tool) => tool.name);
		observations.push({ model: selected.id, sessionId: options?.sessionId, available, role: latest?.role });
		if (latest?.role === "toolResult") return { stopReason: "stop", content: [{ type: "text", text: text(latest.content) }] };
		const prompt = text(latest?.content);
		if (prompt === "fixture-availability") return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(available) }] };
		assert.ok(prompt.startsWith("fixture-tool:"), "only explicit offline fixture prompts are accepted");
		const command = JSON.parse(prompt.slice("fixture-tool:".length));
		beforeToolResponse?.(command, available);
		return { stopReason: "toolUse", content: [{ type: "toolCall", id: `fixture-${serial}`, name: command.name, arguments: command.args }] };
	};
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
		modelsStorePath: join(directory, "root-model-store.json"), allowModelNetwork: false });
	runtime.registerNativeProvider(providerFixture(respond));
	const rootManager = SessionManager.inMemory(rootCwd, { id: "root-tool-fixture" });
	const loader = new DefaultResourceLoader({ cwd: rootCwd, agentDir, settingsManager: SettingsManager.inMemory(settings),
		additionalExtensionPaths: [fixturePath, ...(search ? [SEARCH_SOURCE] : [])], noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	({ session: rootSession } = await createAgentSession({ cwd: rootCwd, agentDir, model: MODELS[0], modelRuntime: runtime,
		sessionManager: rootManager, settingsManager: SettingsManager.inMemory(settings), resourceLoader: loader,
		tools: ["custom_inventory", "restricted_action", "newly_enabled", "local_policy_tool", ...(search ? ["web_search"] : [])] }));
	await rootSession.bindExtensions({ mode: "rpc" });
	rootSession.setActiveToolsByName(initialActive);
	const rootCatalogs = [];
	const host = { rootSessionId: rootManager.getSessionId(), cwd: rootCwd, agentDir,
		isProjectTrusted: () => false,
		resolveModel: (ref) => MODELS.find((candidate) => candidate.provider === ref.provider && candidate.id === ref.id),
		getActiveToolNames: () => rootSession.getActiveToolNames(),
		getToolInfo() {
			const catalog = rootSession.getAllTools();
			for (const item of catalog) assert.ok(item.sourceInfo.source === "builtin" || isAbsolute(item.sourceInfo.path), "root catalog must not contain synthetic child sources");
			rootCatalogs.push(catalog); return catalog;
		},
		getFlag: (name) => name === "allow-restricted" ? false : undefined,
		async prepareModelRuntime(_ref, childRuntime) { childRuntime.registerNativeProvider(providerFixture(respond)); },
	};
	return { directory, agentDir, rootCwd, rootSession, rootManager, fixturePath, auditPath, observations, requests, rootCatalogs,
		setActive(names) { rootSession.setActiveToolsByName(names); },
		beforeResponse(callback) { beforeToolResponse = callback; },
		async audit() {
			try { return (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
			catch (error) { if (error.code === "ENOENT") return []; throw error; }
		},
		async open(id, { modelIndex = 1, parentId = rootManager.getSessionId(), activeAccessor = true,
			descriptorTools = ["obsolete-launch-selection"], customTools = [], intrinsicToolNames = [] } = {}) {
			const cwd = join(directory, id); await mkdir(cwd, { recursive: true });
			const manager = SessionManager.inMemory(cwd, { id });
			const boundHost = { ...host }; if (!activeAccessor) delete boundHost.getActiveToolNames;
			const child = { manager, cwd, driver: await new PiSdkDriverFactory(boundHost).open({
				signal: AbortSignal.timeout(15000),
				descriptor: { version: 2, projectTrusted: false, childSessionId: id, rootSessionId: rootManager.getSessionId(), parentSessionId: parentId,
					mode: "continuable", context: "fresh", provider: "pi-sdk", label: id, depth: parentId === rootManager.getSessionId() ? 1 : 2,
					cwd, createdAt: 1, model: { provider: MODELS[modelIndex].provider, id: MODELS[modelIndex].id }, thinkingLevel: "off", toolNames: descriptorTools },
				sessionManager: manager, customTools, intrinsicToolNames,
				authority: { sessionId: id, rootSessionId: rootManager.getSessionId(), depth: parentId === rootManager.getSessionId() ? 1 : 2, generation: "offline", token: Symbol(id) },
			}) };
			children.push(child); return child;
		},
	};
}

const executed = (manager) => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "tool-inheritance/executed").map((entry) => entry.data);
const toolResults = (manager) => manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "toolResult").map((entry) => entry.message);
async function call(child, name, args) {
	const result = await child.driver.prompt(promptTool(name, args));
	assert.equal(result.stopReason, "completed", result.errorMessage);
	return result;
}

test("actual web_search inherits child-selected Codex model and child session in its fake POST", { timeout: 25000 }, async (t) => {
	const h = await integration(t, { search: true, initialActive: ["web_search"] });
	const a = await h.open("search-child");
	const b = await h.open("search-grandchild", { modelIndex: 2, parentId: a.manager.getSessionId() });
	for (const child of [a, b]) {
		const outcome = await call(child, "web_search", { search_query: [{ q: "offline inheritance fixture" }], response_length: "short" });
		assert.match(outcome.output, /OFFLINE SEARCH RESULT/);
		assert.equal(toolResults(child.manager).at(-1).isError, false);
	}
	assert.deepEqual(h.requests.map((request) => ({ id: request.body.id, model: request.body.model })), [
		{ id: "search-child", model: "child-codex-fixture" }, { id: "search-grandchild", model: "grandchild-codex-fixture" },
	]);
	assert.ok(h.requests.every((request) => request.body.id !== "root-tool-fixture" && request.body.model !== MODELS[0].id));
	assert.equal(h.rootCatalogs.length, 2);
	assert.ok(h.rootCatalogs.every((catalog) => catalog.find((tool) => tool.name === "web_search").sourceInfo.path === SEARCH_SOURCE));
	assert.deepEqual(new Set(h.observations.map((entry) => entry.sessionId)), new Set(["search-child", "search-grandchild"]));
});

test("arbitrary tools use child cwd/model/session, retain false parent flags and hooks, and isolate shutdown state", { timeout: 25000 }, async (t) => {
	const h = await integration(t);
	const rootTool = h.rootSession.agent.state.tools.find((tool) => tool.name === "custom_inventory");
	assert.equal((await rootTool.execute("root-before", {})).details.calls, 1);
	const a = await h.open("inventory-child");
	const b = await h.open("inventory-grandchild", { parentId: a.manager.getSessionId(), modelIndex: 2 });
	await call(a, "custom_inventory"); await call(a, "custom_inventory"); await call(b, "custom_inventory");
	assert.deepEqual(executed(a.manager).map((item) => item.calls), [1, 2]);
	assert.deepEqual(executed(b.manager).map((item) => item.calls), [1]);
	for (const [child, selectedModel] of [[a, MODELS[1]], [b, MODELS[2]]]) {
		const value = executed(child.manager)[0];
		assert.equal(value.cwd, child.cwd); assert.equal(value.model, selectedModel.id);
		assert.equal(value.id, child.manager.getSessionId()); assert.equal(value.started, value.id);
		assert.equal(value.factoryFlag, false); assert.equal(value.flag, false);
		assert.match(value.source, /<inline:/, "child runtime metadata is synthetic, but descendants still loaded from root sources");
	}
	assert.ok(h.rootCatalogs.every((catalog) => catalog.find((tool) => tool.name === "custom_inventory").sourceInfo.path === h.fixturePath));
	const denied = await call(a, "restricted_action");
	assert.match(denied.output, /fixture permission retained: parent flag is false/);
	assert.equal(toolResults(a.manager).at(-1).isError, true);
	assert.equal(executed(a.manager).length, 2);
	await a.driver.dispose();
	await call(b, "custom_inventory");
	assert.equal(executed(b.manager).at(-1).calls, 2); assert.equal(executed(b.manager).at(-1).stopped, false);
	const rootAfter = (await rootTool.execute("root-after", {})).details;
	assert.equal(rootAfter.calls, 2); assert.equal(rootAfter.stopped, false, "child shutdown must not stop root module state");
	assert.deepEqual(await h.audit(), [{ kind: "shutdown", id: "inventory-child", calls: 2 }]);
	await b.driver.dispose();
	assert.deepEqual((await h.audit()).map((entry) => entry.id), ["inventory-child", "inventory-grandchild"]);
	assert.equal(h.requests.length, 0);
});

test("live parent enable/revoke gates coexist with child provider removals and ignore stale descriptor selection", { timeout: 25000 }, async (t) => {
	const h = await integration(t, { initialActive: ["custom_inventory", "local_policy_tool"] });
	const child = await h.open("live-selection-child");
	let available = JSON.parse((await child.driver.prompt("fixture-availability")).output);
	assert.ok(available.includes("custom_inventory"));
	assert.ok(!available.includes("local_policy_tool"), "parent sync must not undo child setActiveTools removal");
	assert.ok(!available.includes("obsolete-launch-selection"));
	assert.ok(!available.includes("newly_enabled"));
	h.setActive(["custom_inventory", "newly_enabled", "local_policy_tool"]);
	await call(child, "newly_enabled");
	assert.equal(executed(child.manager).at(-1)?.name, "newly_enabled", "a tool absent from launch selection can be enabled by the live parent");
	available = JSON.parse((await child.driver.prompt("fixture-availability")).output);
	assert.ok(available.includes("newly_enabled")); assert.ok(!available.includes("local_policy_tool"));
	const before = executed(child.manager).length;
	h.beforeResponse((command, advertised) => {
		if (command.name !== "custom_inventory") return;
		assert.ok(advertised.includes("custom_inventory"));
		h.setActive([]); h.beforeResponse(undefined);
	});
	const revoked = await call(child, "custom_inventory");
	assert.match(revoked.output, /not enabled in the parent|parent.*revok/i);
	assert.equal(toolResults(child.manager).at(-1).isError, true);
	assert.equal(executed(child.manager).length, before, "revocation is rechecked immediately before execution");
	h.setActive(["custom_inventory", "local_policy_tool"]);
	await call(child, "custom_inventory");
	assert.equal(executed(child.manager).length, before + 1);
	available = JSON.parse((await child.driver.prompt("fixture-availability")).output);
	assert.ok(!available.includes("local_policy_tool"));
});

test("a root SDK exclusion cannot be mistaken for a child-only control capability", { timeout: 25000 }, async (t) => {
	const h = await integration(t, { initialActive: ["custom_inventory"] });
	let deniedCalls = 0;
	const tool = (name, execute) => ({ name, label: name, description: "Offline control fixture",
		parameters: Type.Object({}), execute });
	const result = () => ({ content: [{ type: "text", text: "intrinsic report" }], details: {} });
	const child = await h.open("excluded-control-child", {
		customTools: [tool("send_message", async () => { deniedCalls++; return result(); }), tool("report", async () => result())],
		intrinsicToolNames: ["report"],
	});
	const available = JSON.parse((await child.driver.prompt("fixture-availability")).output);
	assert.ok(available.includes("report"));
	assert.ok(!available.includes("send_message"));
	await call(child, "send_message");
	assert.equal(toolResults(child.manager).at(-1).isError, true);
	assert.equal(deniedCalls, 0);
	assert.match((await call(child, "report")).output, /intrinsic report/);
});

test("descriptor names remain a fallback only when the live parent selection accessor is absent", { timeout: 25000 }, async (t) => {
	const h = await integration(t, { initialActive: ["newly_enabled"] });
	const child = await h.open("fallback-selection-child", { activeAccessor: false, descriptorTools: ["custom_inventory"] });
	const available = JSON.parse((await child.driver.prompt("fixture-availability")).output);
	assert.ok(available.includes("custom_inventory")); assert.ok(!available.includes("newly_enabled"));
	await call(child, "custom_inventory");
	assert.equal(executed(child.manager).length, 1);
});

for (const phase of ["factory", "session_start"]) test(`failed child ${phase} rejects opening and runs registered shutdown cleanup`, { timeout: 25000 }, async (t) => {
	const h = await integration(t, { initialActive: ["custom_inventory"] });
	await writeFile(h.fixturePath, `import { appendFileSync } from "node:fs";
		export default async pi => {
			pi.on("session_shutdown", () => appendFileSync(${JSON.stringify(h.auditPath)}, JSON.stringify({ kind: "failed-${phase}-cleanup" }) + "\\n"));
			pi.registerTool({ name: "custom_inventory", label: "fixture", description: "fixture", parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [], details: {} }) });
			${phase === "factory" ? 'await Promise.resolve(); throw new Error("offline factory failure");' : 'pi.on("session_start", async () => { await Promise.resolve(); throw new Error("offline session_start failure"); });'}
		};`);
	await assert.rejects(h.open(`failure-${phase}`), new RegExp(`offline ${phase} failure`));
	assert.deepEqual(await h.audit(), [{ kind: `failed-${phase}-cleanup` }], "failed opening must run cleanup exactly once, including pre-bind factory failures");
	assert.equal(h.requests.length, 0);
});
