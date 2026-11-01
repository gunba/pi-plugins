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
import { HostQuests } from "../src/host/host-quests.ts";
import { QuestStore } from "../../pi-agents/quests.ts";
import { HOME_MODEL, homeBlob, homeItems } from "../src/shared/home.ts";
import { SessionCatalog } from "../src/host/session-files.ts";

const item = (id = "review") => ({ id, ref: { kind: "quest", id: "quest-1" }, title: "Review changes", subtitle: "Website", status: "Waiting for you",
	icon: "preview", x: 20, y: 30, width: 320, height: 190, shape: "blob", seed: 17, wobble: 0.15, color: "accent", outline: "dashed" });
const element = item => { const { id, shape, ...props } = item; return { type: shape[0].toUpperCase() + shape.slice(1), props }; };
const add = item => [{ op: "add", path: `/elements/${item.id}`, value: element(item) }, { op: "add", path: "/elements/canvas/children/-", value: item.id }];
const fixture = t => {
	const directory = mkdtempSync(join(tmpdir(), "desk-home-"));
	const store = new HomeStore(directory);
	store.set("quests", { quests: [{ id: "quest-1", title: "Review changes", state: "open" }], upcoming: [] });
	// Windows cannot remove a folder while a database in it is open, so everything a test opens there closes first.
	const closing = [];
	t.after(() => { for (const close of closing) close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
	return { directory, store, closing };
};

test("first Home scene includes every real open quest, reopened daily, upcoming repeat and live-work reference", t => {
	let now = Date.parse("2026-10-31T12:00:00+08:00"); t.mock.method(Date, "now", () => now);
	const directory = mkdtempSync(join(tmpdir(), "home-current-quests-"));
	const store = new HomeStore(join(directory, "home")), log = new QuestStore(join(directory, "party"), "Australia/Perth");
	t.after(() => { store.close(); log.close(); rmSync(directory, { recursive: true, force: true }); });
	assert.deepEqual(store.scene().spec, { root: "canvas", elements: { canvas: { type: "Canvas", props: {}, children: [] } } });
	assert.throws(() => store.patch({ revision: 0, operations: add(item()) }), /real quest log has not loaded/);
	const main = log.apply({ kind: "you" }, { action: "add", title: "Existing current task" });
	const daily = log.apply({ kind: "you" }, { action: "add", title: "Existing repeating daily", repeat: { unit: "day", from: "2026-10-31" } });
	log.apply({ kind: "you" }, { action: "complete", id: daily.id });
	const future = log.apply({ kind: "you" }, { action: "add", title: "Existing future repeat", repeat: { unit: "day", from: "2026-11-02" } });
	now = Date.parse("2026-11-01T12:00:00+08:00");
	assert.equal(log.get(daily.id).state, "done", "stored state alone would miss today's reopened daily");
	const view = log.view();
	assert.equal(view.quests.find(quest => quest.id === daily.id).state, "open");
	store.set("quests", view);
	store.set("work", [
		{ id: "asking", title: "Approval waiting", status: "Waiting on you", detail: "Approve?" },
		{ id: "working", computer: "laptop", view: "subagent-1", title: "Active agent", status: "Working", detail: "" },
		{ id: "blocked", view: "plan", title: "Blocked plan", status: "Blocked", detail: "Need access" },
	]);
	const required = store.required();
	assert.deepEqual(new Set(required.map(value => value.ref)), new Set([
		{ kind: "quest", id: main.id }, { kind: "quest", id: daily.id }, { kind: "quest", id: future.id },
		{ kind: "conversation", id: "asking" }, { kind: "conversation", id: "working", computer: "laptop", view: "subagent-1" }, { kind: "conversation", id: "blocked", view: "plan" },
	]));
	assert.throws(() => store.patch({ revision: 0, operations: add(item()) }), /quest references absent from the real log/);
	assert.throws(() => store.patch({ revision: 0, operations: add({ ...item(), ref: { kind: "quest", id: main.id } }) }), /Include every open\/upcoming quest and live work item/);
	assert.equal(store.scene().revision, 0);
	const entries = required.map((value, index) => [`task-${index}`, element({ ...item(`task-${index}`), ...value })]);
	const elements = { canvas: { type: "Canvas", props: {}, children: entries.map(([id]) => id) }, ...Object.fromEntries(entries) };
	const scene = store.patch({ revision: 0, operations: [{ op: "replace", path: "/elements", value: elements }] });
	assert.deepEqual(homeItems(scene).map(value => value.ref), required.map(value => value.ref));
	assert.throws(() => store.patch({ revision: 1, operations: [{ op: "remove", path: "/elements/task-0" }, { op: "remove", path: "/elements/canvas/children/0" }] }), /Missing/);
	assert.deepEqual(store.scene(), scene);
});

test("scene patches are atomic, schema checked, and cannot erase a drag", t => {
	const { directory, store, closing } = fixture(t), other = new HomeStore(directory); closing.push(() => other.close());
	store.patch({ revision: 0, operations: add(item()) });
	other.drag("review", 500, 240);
	assert.throws(() => store.patch({ revision: 1, operations: [{ op: "remove", path: "/elements/review" }] }), /Home changed/);
	const scene = store.patch({ revision: 2, operations: [{ op: "replace", path: "/elements/review", value: element({ ...item(), title: "Review the draft", x: 0, y: 0 }) }] });
	assert.deepEqual(homeItems(scene), [{ ...item(), title: "Review the draft", x: 500, y: 240 }]);
	assert.deepEqual(scene.preferences, { review: { x: 500, y: 240 } });
	assert.throws(() => store.patch({ revision: 3, operations: [{ op: "replace", path: "/elements/review/props/title", value: "Do not commit" }, { op: "add", path: "/elements/line", value: { type: "Connector", props: { from: "review", to: "missing", bend: 0 } } }, { op: "add", path: "/elements/canvas/children/-", value: "line" }] }), /existing, different items/);
	assert.deepEqual(other.scene(), scene, "a rejected operation rolls back the entire patch");
	for (const invalid of [{ color: "#00aaff" }, { icon: "not-an-icon" }, { x: Infinity }, { width: 0 }, { wobble: 1 }, { svg: "<script>" }])
		assert.throws(() => store.patch({ revision: 3, operations: [{ op: "replace", path: "/elements/review", value: element({ ...item(), ...invalid }) }] }), /Invalid Home component props|UI numbers must be finite|Unknown component or property/);
	assert.deepEqual(other.scene(), scene);
	const moved = store.patch({ revision: 3, operations: [{ op: "replace", path: "/elements/review/props/x", value: 100 }] }, ["review"]);
	assert.equal(homeItems(moved)[0].x, 100);
	assert.deepEqual(moved.preferences, {});
});

test("references reject executable URLs and items and connectors are removed in one shared patch", t => {
	const { store } = fixture(t);
	for (const url of ["javascript:alert(1)", "data:text/html,bad", "file:///secret", "https://secret@example.org"])
		assert.throws(() => store.patch({ revision: 0, operations: add({ ...item(), ref: { kind: "url", url } }) }), /HTTP or HTTPS/);
	store.patch({ revision: 0, operations: [...add(item()), ...add(item("work")), { op: "add", path: "/elements/line", value: { type: "Connector", props: { from: "review", to: "work", bend: 20 } } }, { op: "add", path: "/elements/canvas/children/-", value: "line" }] });
	const removed = store.patch({ revision: 1, operations: [{ op: "remove", path: "/elements/work" }, { op: "remove", path: "/elements/line" }, { op: "replace", path: "/elements/canvas/children", value: ["review"] }] });
	assert.deepEqual(Object.keys(removed.spec.elements), ["canvas", "review"]);
	const path = homeBlob(item());
	assert.equal(path, homeBlob(item()));
	assert.equal((path.match(/ C /g) ?? []).length, 14);
	assert.match(path, /^M [\d. -]+ C .* Z$/);
	const box = item(), coordinates = path.match(/-?\d+(?:\.\d+)?/g).map(Number);
	assert.ok(coordinates.every((value, index) => value >= -0.1 && value <= (index % 2 ? box.height : box.width) + 0.1), "the outline stays inside its box");
});

test("quest command recovery never silently replays an uncertain write", t => {
	const { store } = fixture(t), id = randomUUID(), command = { action: "complete", id: "quest" };
	store.request(id, command); assert.equal(store.claim(id), true); assert.equal(store.claim(id), false);
	store.recover();
	assert.deepEqual(store.pending(), []);
	assert.deepEqual(store.result(id), { error: "Desk restarted during this change. Read the quest log before deciding whether to repeat it." });
	assert.throws(() => store.request(id, { action: "abandon", id: "quest" }), /another command/);
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
		}, waitForSession: async key => sessions.get(key), inputEvent() {}, drainInputs: managed => admitted.push(inputs.next(managed.view.key)), attachments: () => ({ check() {} }) };
	const quests = new HostQuests({ closing: () => false, changed() {}, parties: () => undefined, computer: () => undefined });
	quests.open(directory); quests.refresh();
	let enabled = true;
	const home = new Home(core, quests, () => enabled, () => [], notify);
	t.after(() => { home.close(); quests.close(); inputs.close(); rmSync(directory, { recursive: true, force: true }); });
	return { home, core, quests, admitted, disable: () => { enabled = false; } };
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
	assert.throws(() => home.drag("missing", 1, 2), /workspace server/);
});

test("changes coalesce into one persistent conversation turn, and Home can finish another agent's quest", async t => {
	let now = 1000; t.mock.method(Date, "now", () => now);
	const { home, core, quests, admitted } = controller(t);
	const quest = await quests.log().apply({ kind: "agent", id: "reviewer", label: "Reviewer" }, { action: "add", title: "Review the result" });
	await home.tick(); assert.equal(admitted.length, 0);
	await quests.log().apply({ kind: "you" }, { action: "update", id: quest.id, title: "Review the final result" });
	now = 4001; await home.tick();
	assert.equal(admitted.length, 1);
	assert.match(admitted[0].input.command.text, /Review the final result/);
	assert.equal(core.sessions.size, 1);
	await home.tick(); assert.equal(admitted.length, 1);
	const request = randomUUID(); home.store.request(request, { action: "complete", id: quest.id });
	await home.tick();
	assert.equal((await quests.log().get(quest.id)).state, "done");
	assert.equal(home.store.result(request).value.state, "done");
	assert.deepEqual(home.store.required(), [], "the scene can remove a finished quest as soon as its tool receipt is available");
});

test("overlap labelling is persistent and scheduled Home alerts use an explicit phone delivery path", async t => {
	const notices = [], { home } = controller(t, async notice => { notices.push(notice); });
	home.settings(true);
	const id = randomUUID(); home.store.request(id, { action: "notify", title: "Daily roundup", text: "A useful new article." });
	await home.tick(); await home.tick();
	assert.deepEqual(notices, [{ title: "Home: Daily roundup", body: "A useful new article.", tag: `home:${id}`, session: "home" }]);
	assert.deepEqual(home.store.result(id), { value: { delivered: true, message: id } });
	assert.equal(home.snapshot().messages.at(-1).text, "A useful new article.");
	home.settings(false);
	const second = randomUUID(); home.store.request(second, { action: "notify", title: "Daily roundup", text: "Another update." });
	await home.tick();
	assert.equal(notices[1].title, "Daily roundup");
	assert.equal(home.snapshot().overlap, false);
});

test("every Home turn reads the current overlap setting, including scheduled wakes after compaction", t => {
	const { directory, store, closing } = fixture(t), handlers = new Map(), tools = new Map();
	installHome({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool) }, directory);
	closing.push(() => handlers.get("session_shutdown")());
	store.set("overlap", true);
	assert.match(handlers.get("before_agent_start")({ systemPrompt: "Normal Pi tools" }).systemPrompt, /Prefix every outgoing scheduled email subject/);
	store.set("overlap", false);
	assert.match(handlers.get("before_agent_start")({ systemPrompt: "Normal Pi tools" }).systemPrompt, /Normal\. Do not add a Home:/);
	assert.deepEqual([...tools.keys()], ["home_scene", "home_quest", "home_jobs", "home_notify"]);
});
