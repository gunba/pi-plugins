import assert from "node:assert/strict";
import test from "node:test";
import { activateNewTools } from "../src/host/new-tools.ts";
import { REQUEST_PREFIX } from "../../pi-tools/index.ts";

// Each system message lists the tools it added and removed.
const session = (messages, tools, active, defaults) => {
	let selected = [...active];
	return {
		settingsManager: { getDefaultTools: () => defaults },
		sessionManager: { getBranch: () => messages.map(({ added = [], removed = [] }) => ({ type: "message", message: { role: "system",
			toolsAdded: added.map(name => ({ name })), toolsRemoved: removed.map(name => ({ name })) } })) },
		getActiveToolNames: () => selected,
		getAllTools: () => tools.map(({ name, exposure, source }) => ({ name, exposure, sourceInfo: { source: source ?? "extension" } })),
		getToolDefinition: name => tools.find(tool => tool.name === name),
		setActiveToolsByName: names => { selected = names; },
		selected: () => selected,
	};
};

test("a resumed conversation gets tools added since it began, not ones it dropped, that start off, or Pi's own optional ones", () => {
	// Pi restored only what the conversation had declared, so agent_discover and web_search, added later, never reached it.
	const tools = [{ name: "read" }, { name: "agent_create", exposure: "deferred" }, { name: "agent_discover" }, { name: "web_search" },
		{ name: "dropped" }, { name: "loader", defaultActive: false }, { name: "mcp__server__tool" }, { name: "switched_off" },
		{ name: "chrome_devtools_navigate", exposure: "codemode" }, { name: "powershell", source: "builtin" }, { name: "grep", source: "builtin" }];
	const resumed = session([{ added: ["read", "agent_create", "dropped"], removed: ["dropped"] }], tools, ["read", "agent_create"]);
	assert.deepEqual(activateNewTools(resumed, { switched_off: false }), ["agent_discover", "web_search"]);
	assert.deepEqual(resumed.selected(), ["read", "agent_create", "agent_discover", "web_search"]);
	const fresh = session([], tools, ["read"]);
	assert.deepEqual(activateNewTools(fresh, {}), []);
});

test("Pi's optional tools go off unless the user chose them, in context settings or Pi's default tools", () => {
	// Codex conversations started with grep, find and ls; Desk 0.5.171 to 0.5.181 later added powershell too.
	const tools = ["read", "powershell", "grep", "find", "ls"].map(name => ({ name, source: "builtin" }));
	const resumed = session([{ added: ["read", "grep", "find", "ls"] }, { added: ["powershell"] }], tools,
		["read", "powershell", "grep", "find", "ls"], ["+codemode", "+grep"]);
	assert.deepEqual(activateNewTools(resumed, { ls: true }), []);
	assert.deepEqual(resumed.selected(), ["read", "grep", "ls"]);
});

test("a resumed conversation with the single codemode tool gets back the tools its programs call", () => {
	// Hidden behind codemode, Pi's bash, edit and write counted as dropped, and conversations resumed without them.
	const tools = [{ name: "codemode", description: `${REQUEST_PREFIX} …` }, { name: "read", source: "builtin" }, { name: "bash", source: "builtin" },
		{ name: "edit", source: "builtin" }, { name: "write", source: "builtin" }, { name: "grep", source: "builtin" }, { name: "web_search" },
		{ name: "switched_off" }, { name: "later", exposure: "deferred" }, { name: "mcp__server__tool" }];
	const resumed = session([{ added: ["bash", "edit", "write", "web_search", "codemode"], removed: ["bash", "edit", "write", "web_search"] }],
		tools, ["codemode", "read"], ["+codemode"]);
	assert.deepEqual(activateNewTools(resumed, { switched_off: false }), ["bash", "edit", "write", "web_search"]);
	assert.deepEqual(resumed.selected(), ["codemode", "read", "bash", "edit", "write", "web_search"]);
	const chosen = session([{ added: ["codemode"] }], tools, ["codemode"], ["read", "grep"]);
	assert.deepEqual(activateNewTools(chosen, { switched_off: false }), ["read", "grep", "web_search"], "defaultTools that name tools replace Pi's own list");
});
