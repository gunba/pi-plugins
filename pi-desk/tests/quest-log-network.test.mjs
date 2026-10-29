import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PartyStore } from "../../pi-agents/store.ts";
import { PartyOperations } from "../../pi-agents/operations.ts";
import { QUEST_LOG, QUEST_NOTICES, QuestCalls } from "../../pi-agents/quest-log.ts";
import { HostQuests } from "../src/host/host-quests.ts";
import { PartyNetwork } from "../src/host/party-network.ts";

const SERVER = "11111111-1111-4111-8111-111111111111", LAPTOP = "22222222-2222-4222-8222-222222222222";
const WORKER = "33333333-3333-4333-8333-333333333333", OWNER = "44444444-4444-4444-8444-444444444444";

function computer(t, id, operations) {
	const dir = mkdtempSync(join(tmpdir(), "quest-log-network-")), store = new PartyStore(join(dir, "party"));
	const quests = new HostQuests({ closing: () => false, changed() {}, parties: () => ({ store }), computer: () => id });
	quests.open(dir);
	const network = new PartyNetwork(store, "scope", () => {}, undefined, { name: id === SERVER ? "server" : "laptop", platform: "linux", version: "1", operations },
		undefined, undefined, undefined, quests);
	t.after(() => { network.close(); quests.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
	return { dir, store, quests, network };
}

// Tasks were kept by each computer, so a computer that was offline took its tasks with it.
test("one computer keeps the quest log for all, takes the others' quests and answers their agents", async t => {
	const server = computer(t, SERVER, [QUEST_LOG, QUEST_NOTICES]), laptop = computer(t, LAPTOP, [QUEST_NOTICES]);
	laptop.store.register(WORKER, OWNER, "Worker", "/work");
	const old = laptop.quests.store.apply({ kind: "agent", id: WORKER, label: "Worker" }, { action: "add", title: "Review the BAS draft" });
	laptop.quests.store.apply({ kind: "you" }, { action: "add", title: "Renew the domain" });
	// Each side's first packets wait until both have connected, as over the relay.
	const link = (to, from) => async packet => { await new Promise(resolve => setImmediate(resolve)); await to.network.receive(from, structuredClone(packet)); };
	server.network.connected(LAPTOP, link(laptop, SERVER), () => {});
	laptop.network.connected(SERVER, link(server, LAPTOP), () => {});
	const pump = async () => { for (let round = 0; round < 10; round++) { server.network.flush(); laptop.network.flush(); await new Promise(resolve => setTimeout(resolve, 5)); } };
	await pump();

	server.quests.refresh(); laptop.quests.refresh();
	assert.deepEqual(server.quests.view.quests.map(quest => quest.title).sort(), ["Renew the domain", "Review the BAS draft"]);
	const moved = server.quests.view.quests.find(quest => quest.title === "Review the BAS draft");
	assert.equal(moved.source.id, `${WORKER}@${LAPTOP}`);
	assert.deepEqual(laptop.quests.store.batch(), [], "the laptop's quests now live on the server");
	assert.equal(laptop.quests.view, undefined, "only the computer that keeps the log shows it");

	// An agent on the laptop uses the log as before, through the laptop's Desk.
	const operations = new PartyOperations(join(laptop.dir, "party"));
	operations.touchHost(); operations.close();
	const calls = new QuestCalls(join(laptop.dir, "party"));
	const log = calls.remote();
	const [view, added] = await Promise.all([log.view(), log.apply({ kind: "agent", id: WORKER, label: "Worker" }, { action: "add", title: "Sign the letter" }), pump()]);
	assert.equal(view.quests.find(quest => quest.id === old.id || quest.title === "Review the BAS draft").source.id, WORKER, "the laptop sees its agent as its own");
	assert.equal(added.source.id, WORKER);
	await assert.rejects(Promise.all([log.apply({ kind: "agent", id: WORKER, label: "Worker" }, { action: "complete", id: server.quests.view.quests.find(quest => quest.title === "Renew the domain").id }), pump()]),
		/Agents can only change quests they added/);

	// Jordan finishes it on the server; the agent that added it on the laptop is told there, even after it has closed.
	laptop.store.release(WORKER, OWNER);
	await server.quests.log().apply({ kind: "you" }, { action: "complete", id: moved.id });
	await pump();
	calls.close();
	const [notice] = laptop.store.pending(WORKER, OWNER);
	assert.match(notice.text, /^Jordan completed the quest you added: “Review the BAS draft”/);
});
