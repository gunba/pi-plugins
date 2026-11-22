import assert from "node:assert/strict";
import test from "node:test";
import { ConversationMoves } from "../src/host/conversation-moves.ts";
import { MOVED } from "../src/host/watches.ts";

function moves(view) {
	const ended = [], sessions = new Map([[view.key, { view }]]);
	const core = { sessions, endWatches: (session, reason) => ended.push([session, reason]), persist() {}, emit() {}, options: {} };
	const host = { teleport: () => undefined, parties: () => undefined, network: () => undefined, self: () => "sydney", moving: () => false };
	return { moves: new ConversationMoves(core, host), ended, managed: sessions.get(view.key) };
}

test("a conversation given up for a move keeps its watches until the other computer has it, and Home is never given up", async () => {
	// 22 November 2026: Home moved itself to fetch a web page from CachyOS. Its ten watches ended when Sydney gave it up,
	// the transfer then failed, and Home came back on Sydney with no schedule.
	const { moves: home, ended: homeEnded, managed: homeView } = moves({ key: "h", agentId: "home", home: true, file: "/tmp/home.jsonl", cwd: "/tmp", state: "closed" });
	await assert.rejects(home.release("home"), /Home stays on the workspace server/);
	assert.deepEqual(homeEnded, []);
	assert.equal(homeView.view.kept, undefined);

	const { moves: other, ended, managed } = moves({ key: "k", agentId: "agent", file: "/tmp/agent.jsonl", cwd: "/tmp", state: "closed" });
	assert.deepEqual(await other.release("agent"), { file: "/tmp/agent.jsonl", cwd: "/tmp" });
	assert.deepEqual(ended, [], "a move that fails now leaves its watches set");
	assert.equal(managed.view.kept, true);
	await other.retire("agent", { from: "sydney", to: "cachyos", at: 1 });
	assert.deepEqual(ended, [["agent", MOVED]]);
	assert.deepEqual(managed.view.moved, { from: "sydney", to: "cachyos", at: 1 });
});
