import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { lazyMcpTransports } from "../lazy-mcp.ts";

const { McpClient } = await import(createJiti(import.meta.resolve("@earendil-works/pi-coding-agent")).esmResolve("@earendil-works/pi-mcp"));

// Appends one line per process start to the file named by its first argument.
const SERVER = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.argv[2], process.pid + "\\n");
const tools = [{ name: "echo", inputSchema: { type: "object" } }];
createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	const result = message.method === "initialize"
		? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
		: message.method === "tools/list" ? { tools }
		: { content: [{ type: "text", text: String(process.pid) }] };
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

test("stdio servers start on the first call, stop when idle and restart on the next call", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "lazy-mcp-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const script = join(dir, "server.mjs");
	const starts = join(dir, "starts");
	writeFileSync(script, SERVER);
	writeFileSync(starts, "");
	const entry = { name: "fixture", config: { command: process.execPath, args: [script, starts] } };
	const create = await lazyMcpTransports({ idleMs: 100, cacheDir: join(dir, "cache") });
	const started = () => readFileSync(starts, "utf8").split("\n").filter(Boolean);
	const connect = async () => {
		const transport = create(entry, dir, undefined);
		const client = new McpClient({ name: "test", version: "1" });
		await client.connect(transport);
		return { client, transport, tools: await client.listTools() };
	};

	// No answers cached yet: the server starts to answer, then stops when idle.
	const first = await connect();
	assert.deepEqual(first.tools.map((tool) => tool.name), ["echo"]);
	assert.equal(started().length, 1);
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(first.transport.pid, undefined);
	await first.client.close();

	// Cached answers connect a session without a process; a call starts one.
	const second = await connect();
	assert.deepEqual(second.tools.map((tool) => tool.name), ["echo"]);
	assert.equal(started().length, 1);
	const call = await second.client.callTool("echo", {});
	assert.equal(call.content[0].text, started()[1]);
	assert.ok(second.transport.pid);

	// Idle: the process stops while the session stays connected; the next call starts another.
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(second.transport.pid, undefined);
	assert.equal(second.client.connectionState, "connected");
	const again = await second.client.callTool("echo", {});
	assert.equal(again.content[0].text, started()[2]);
	await second.client.close();
	assert.equal(second.transport.pid, undefined);
	for (const pid of started()) assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
	assert.ok(existsSync(join(dir, "cache")));
});
