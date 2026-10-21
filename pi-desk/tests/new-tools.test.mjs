import assert from "node:assert/strict";
import test from "node:test";
import { activateNewTools } from "../src/host/new-tools.ts";

const session = (declared, removed, tools, active) => {
	let selected = [...active];
	return {
		sessionManager: { getBranch: () => declared.length || removed.length ? [{ type: "message", message: { role: "system",
			toolsAdded: declared.map(name => ({ name })), toolsRemoved: removed.map(name => ({ name })) } }] : [] },
		getActiveToolNames: () => selected,
		getAllTools: () => tools.map(({ name, exposure }) => ({ name, exposure })),
		getToolDefinition: name => tools.find(tool => tool.name === name),
		setActiveToolsByName: names => { selected = names; },
		selected: () => selected,
	};
};

test("a resumed conversation gets tools added since it began, not ones it dropped or that start off", () => {
	// Pi restored only what the conversation had declared, so agent_discover and web_search, added later, never reached it.
	const tools = [{ name: "read" }, { name: "agent_create", exposure: "deferred" }, { name: "agent_discover" }, { name: "web_search" },
		{ name: "dropped" }, { name: "loader", defaultActive: false }, { name: "mcp__server__tool" }, { name: "switched_off" },
		{ name: "chrome_devtools_navigate", exposure: "codemode" }];
	const resumed = session(["read", "agent_create", "dropped"], ["dropped"], tools, ["read", "agent_create"]);
	assert.deepEqual(activateNewTools(resumed, { switched_off: false }), ["agent_discover", "web_search"]);
	assert.deepEqual(resumed.selected(), ["read", "agent_create", "agent_discover", "web_search"]);
	const fresh = session([], [], tools, ["read"]);
	assert.deepEqual(activateNewTools(fresh, {}), []);
});
