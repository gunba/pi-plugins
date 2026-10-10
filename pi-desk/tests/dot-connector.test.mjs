import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PartyStore } from "../../pi-party/store.ts";
import { DotConnector } from "../src/host/dot-connector.ts";

test("the Dot connector lets Steve list, message and hear back from agents through agent messaging", async t => {
	const dir = mkdtempSync(join(tmpdir(), "dot-connector-")), store = new PartyStore(join(dir, "party"));
	t.after(() => { connector.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
	const connector = new DotConnector(dir, store, "fedora");
	const rpc = async (method, params, id = 1) => { const r = await connector.handle(JSON.stringify({ jsonrpc: "2.0", id, method, params })); return { status: r.status, body: r.body && JSON.parse(r.body) }; };
	const tool = async (name, args = {}) => JSON.parse((await rpc("tools/call", { name, arguments: args })).body.result.content[0].text);
	assert.equal((await rpc("initialize", {})).status, 404, "disabled until Jordan enables it");
	connector.enable();
	assert.ok(existsSync(join(dir, "dot-connector.json")));
	assert.match(connector.url("https://relay.example"), /^https:\/\/relay\.example\/connector\/[A-Za-z0-9_-]{43}$/);
	assert.equal((await rpc("initialize", { protocolVersion: "2025-06-18" })).body.result.serverInfo.name, "pi-desk");
	assert.equal((await connector.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).status, 202);
	assert.deepEqual((await rpc("tools/list")).body.result.tools.map(item => item.name), ["list_agents", "message_agent", "read_messages"]);

	store.register("worker", "worker-owner", "BD Workbook", "C:\\obsidian");
	store.register("child", "child-owner", "Untitled conversation", "C:\\obsidian", "child");
	assert.equal((await tool("list_agents", { include_children: true })).length, 2);
	const agents = await tool("list_agents");
	assert.deepEqual(agents.map(item => [item.name, item.computer]), [["BD Workbook", "fedora"]], "Steve itself is not listed");
	assert.equal((await tool("message_agent", { agent: "worker", message: "Status of the overnight run?" })).sent, true);
	const [received] = store.pending("worker", "worker-owner");
	assert.equal(received.sender_label, "Steve (Dot)");
	assert.equal(received.wake, 1);
	store.send("worker", "worker-owner", received.sender, "Round 23 is done; waiting on staff data.", false);
	assert.deepEqual((await tool("read_messages")).unread.map(item => [item.from, item.message]), [["BD Workbook", "Round 23 is done; waiting on staff data."]]);
	assert.deepEqual((await tool("read_messages")).unread, [], "read once");
	assert.equal((await tool("read_messages", { history: true })).recent.length, 2);
	const failed = (await rpc("tools/call", { name: "message_agent", arguments: { agent: "nobody", message: "hi" } })).body.result;
	assert.equal(failed.isError, true);

	connector.disable();
	assert.equal((await rpc("tools/list")).status, 404);
	assert.equal(store.member(received.sender).heartbeat, 0, "disabling takes Steve offline");
});
