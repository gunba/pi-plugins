import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installHome } from "../src/host/home-extension.ts";
import { HomeStore } from "../src/host/home-store.ts";
import { Home, homeWork } from "../src/host/home.ts";
import { InputLedger } from "../src/host/inputs.ts";
import { HOME_MODEL } from "../src/shared/home.ts";
import { SessionCatalog } from "../src/host/session-files.ts";
import { settle, unseen } from "../src/shared/attention.ts";

const fixture = t => {
	const directory = mkdtempSync(join(tmpdir(), "desk-home-"));
	const store = new HomeStore(directory);
	// Windows cannot remove a folder while a database in it is open, so everything a test opens there closes first.
	const closing = [];
	t.after(() => { for (const close of closing) close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
	return { directory, store, closing };
};

test("an uncertain delivery is never silently repeated after a restart", t => {
	const { store } = fixture(t), id = randomUUID();
	store.request(id, { action: "notify", title: "Roundup", text: "News." }); assert.equal(store.claim(id), true); assert.equal(store.claim(id), false);
	store.recover();
	assert.deepEqual(store.pending(), []);
	assert.deepEqual(store.result(id), { error: "Desk restarted during this delivery. Check Home before repeating it." });
	assert.throws(() => store.request(id, { action: "notify", title: "Other", text: "News." }), /another command/);
});

const ui = (views = [], interactions = []) => ({ views, interactions });
test("live work includes questions, approvals, running agents and blocked plans, but not Home or token churn", () => {
	const sessions = [
		{ key: "ask", state: "ready", name: "Review", ui: ui([], [{ form: { title: "Approve the draft?" } }]) },
		{ key: "work", state: "ready", title: "Research", snapshot: { activity: "running", tokens: 1 } },
		{ key: "blocked", state: "ready", name: "Ship", ui: ui([{ id: "plan", kind: "details", data: { fields: [{ label: "State", value: "blocked" }, { label: "Blocker", value: "Need access" }] } }]) },
		{ key: "home", home: true, state: "ready", snapshot: { activity: "running" } },
		{ key: "closed", state: "closed", snapshot: { activity: "running" } },
	];
	const expected = homeWork(sessions);
	assert.deepEqual(expected.map(({ id, status, view }) => ({ id, status, view })), [
		{ id: "ask", status: "Waiting on you", view: undefined }, { id: "work", status: "Working", view: undefined }, { id: "blocked", status: "Blocked", view: "plan" },
	]);
	assert.equal(expected[0].detail, "Approve the draft?");
	sessions[1].snapshot.tokens = 99999;
	assert.deepEqual(homeWork(sessions), expected);
});

function controller(t, notify) {
	const directory = mkdtempSync(join(tmpdir(), "desk-home-controller-"));
	const inputs = new InputLedger(directory), sessions = new Map(), admitted = [];
	const core = { directory, sessions, inputs, options: { agentDir: directory }, held: false, closing: false, restoringUpdate: false,
		createSession(cwd, file, existing) {
			sessions.set(existing.view.key, { view: { ...existing.view, state: "ready", activation: "activation", snapshot: { model: HOME_MODEL, thinking: "low", activity: "idle" } },
				worker: { generation: "generation", command: async () => {} } }); return existing.view.key;
		}, waitForSession: async key => sessions.get(key), inputEvent() {}, emit() {}, persistEvent() {}, drainInputs: managed => admitted.push(inputs.next(managed.view.key)), attachments: () => ({ check: ids => ids.map(id => `${id}.png`) }) };
	let enabled = true;
	const work = [], home = new Home(core, () => enabled, () => work, notify); home.startsAlone = () => true;
	t.after(() => { home.close(); inputs.close(); rmSync(directory, { recursive: true, force: true }); });
	return { home, core, work, admitted, disable: () => { enabled = false; } };
}

test("Home reuses one conversation and receipt after a lost response and worker restart", async t => {
	const { home, core, admitted, disable } = controller(t);
	const id = randomUUID();
	await home.message(id, "Keep this together");
	const first = home.snapshot(), managed = core.sessions.get(first.session);
	managed.view.activation = "new-activation"; managed.worker.generation = "new-generation";
	await home.message(id, "Keep this together");
	assert.equal(core.sessions.size, 1); assert.equal(admitted.length, 1);
	assert.deepEqual(home.snapshot().messages, first.messages);
	await assert.rejects(home.message(id, "Different message"), /different contents/);
	new SessionCatalog(core.directory).write([managed.view]);
	assert.equal(new SessionCatalog(core.directory).read()[0].home, true);
	disable(); await assert.rejects(home.open(), /workspace server/);
});

test("Home gives browsers the activation its uploads need and keeps the names of attached files", async t => {
	// Jordan could not attach images to Home: the browser looked for the activation in a list keyed by computer and
	// conversation, found none, and the host refused every upload as stale.
	const { home, core } = controller(t);
	const opened = await home.open();
	assert.equal(opened.activation, core.sessions.get(opened.session).view.activation);
	await home.message(randomUUID(), "What is this rash?", ["photo"]);
	assert.deepEqual(home.snapshot().messages.at(-1).files, ["photo.png"]);
});

test("Home's newest reply or update marks it new until it is seen, though a watch is always set", async t => {
	// Home always has a watch for its scheduled jobs, so it was never marked finished and the Home button never showed news.
	const { home, core } = controller(t, async () => {});
	const opened = await home.open(), managed = core.sessions.get(opened.session);
	managed.view = { ...managed.view, watching: true, wakes: Date.now() + 3_600_000 };
	const id = randomUUID(); home.store.request(id, { action: "notify", title: "Morning", text: "Rain at noon." });
	await home.tick();
	const at = home.snapshot().messages.at(-1).at;
	assert.equal(core.sessions.get(opened.session).view.finished, at);
	assert.equal(unseen(core.sessions.get(opened.session).view), true);
	// A turn running doesn't take the mark away, as it does for other conversations.
	managed.view = { ...core.sessions.get(opened.session).view, snapshot: { ...managed.view.snapshot, activity: "running" } };
	settle(managed);
	assert.equal(managed.view.finished, at);
	managed.view = { ...managed.view, seen: at + 1 };
	await home.tick();
	assert.equal(unseen(managed.view), false);
});

test("scheduled Home alerts use an explicit phone delivery path", async t => {
	const notices = [], { home } = controller(t, async notice => { notices.push(notice); });
	const id = randomUUID(); home.store.request(id, { action: "notify", title: "Daily roundup", text: "A useful new article." });
	await home.tick(); await home.tick();
	assert.deepEqual(notices, [{ title: "Daily roundup", body: "A useful new article.", tag: `home:${id}`, session: "home" }]);
	assert.deepEqual(home.store.result(id), { value: { delivered: true, message: id } });
	assert.equal(home.snapshot().messages.at(-1).text, "A useful new article.");
});
