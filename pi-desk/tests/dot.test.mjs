import assert from "node:assert/strict";
import test from "node:test";
import { dotEntry } from "../src/host/dot-wire.ts";


const items = [
	{ id: "one", role: "user", self: true, senderName: "Owner", createdAt: "2026-10-03T00:00:00Z", text: "Hello" },
	{ id: "two", role: "user", senderAeonId: "dot", senderName: "Dot", createdAt: "2026-10-03T00:00:01Z", text: "Ready." },
];
test("Dot authors use native identity when both transport roles are user", () => {
	const room = { id: "room", dot: "dot", name: "Dot", members: [{ id: "owner" }, { id: "bot", dot: "dot" }] };
	const messages = items.map(item => dotEntry({ id: item.id, role: item.role, account_user_id: item.self ? "owner" : "bot",
		created_at: item.createdAt, content: { text: item.text } }, room, { accountUserId: "owner" }).message);
	assert.deepEqual(messages.map(message => [message.author, message.text]), [["owner", "Hello"], ["dot", "Ready."]]);
});
test("cancelling an unconfirmed Dot send fences late admission across restart", async () => {
	const { DotConnection } = await import("../src/host/dot.ts");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { randomUUID } = await import("node:crypto");
	const directory = mkdtempSync(join(tmpdir(), "pi-dot-admission-")), id = randomUUID();
	const dot = new DotConnection(directory);
	try {
		assert.equal(await dot.input(id), undefined);
		const cancelled = dot.cancelInput(id, "fixture-dot", "fixture message", []);
		assert.equal(cancelled.state, "not-sent");
		assert.deepEqual(dot.send(id, "fixture-dot", "fixture message", []), cancelled);
		const restored = new DotConnection(directory);
		assert.deepEqual(restored.send(id, "fixture-dot", "fixture message", []), cancelled);
		assert.throws(() => restored.send(id, "fixture-dot", "different message", []), /different input/);
		await restored.close();
	} finally { await dot.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("only Dot's own routes are refused on a workspace computer that does not keep copies", async () => {
	const { isDotPath, refusesDot } = await import("../src/host/host-api.ts");
	for (const path of ["/api/sessions/abc/messages", "/api/state", "/api/storage", "/api/dotfiles"]) assert.equal(isDotPath(path), false, path);
	for (const path of ["/api/dot", "/api/dot/connector", "/api/dot/inputs"]) assert.equal(isDotPath(path), true, path);
	assert.equal(refusesDot(true, false), true);
	assert.equal(refusesDot(true, true), false);
	assert.equal(refusesDot(false, false), false);
});
