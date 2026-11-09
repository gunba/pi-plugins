import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchService } from "../src/host/watches.ts";
import { WatchStore } from "../../pi-watch/store.ts";

test("watch events from another computer are cut to fit or dropped, never refused, so the link stays up", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "desk-watch-link-")), computer = randomUUID(), agent = randomUUID(), watch = randomUUID();
	const host = { agentDir, deskDirectory: join(agentDir, "desk"), closing: () => false, live: () => true, wake: () => "waking", hints: () => {},
		member: () => true, computers: () => [{ id: computer, name: "Work PC", online: true, watches: true }], self: () => randomUUID(), label: () => "agent", flush: () => {} };
	const service = new WatchService(host), store = new WatchStore(join(agentDir, "party"));
	try {
		const command = "x".repeat(2_418);
		store.insert({ id: watch, agent, home: "", runs: computer, name: "w1", state: "running", created: 1, progress: {},
			spec: { id: "w1", mode: "output", command, cwd: "", created: 1, computer: "Work PC" } });
		// An unlabelled watch's title is its whole command. Desk 0.5.344 sent it whole, the receiver refused the packet,
		// which dropped the link, and the sender sent it again each time the link came back.
		const long = randomUUID(), unreadable = randomUUID(), replies = [];
		await service.receive(computer, { type: "watch-events", events: [
			{ id: long, watch, agent, name: "w1", text: "It ended.", event: { id: "w1", title: `\`${command}\`, waking you when it ends`, status: "Ended" }, created: 2 },
			{ id: unreadable, watch, agent, name: "w1", text: "It ended.", event: { id: "w1", title: 7, status: "Ended" }, created: 3 },
		] }, async packet => { replies.push(packet); });
		assert.deepEqual(replies, [{ type: "watch-acks", ids: [long, unreadable] }]);
		const kept = store.events(agent, "pending");
		assert.deepEqual(kept.map(event => [event.id, event.event.title.length, event.event.title.endsWith("…")]), [[long, 2_000, true]]);
	} finally {
		store.close(); await service.close();
		rmSync(agentDir, { recursive: true, force: true });
	}
});
