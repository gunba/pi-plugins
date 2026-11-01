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
import { HOME_MODEL, emptyHomeScene, homeBlob, homeItems, homeLayoutProblems } from "../src/shared/home.ts";
import { SessionCatalog } from "../src/host/session-files.ts";

const item = (id = "review") => ({ id, ref: { kind: "url", url: "https://example.com/review" }, title: "Review changes", subtitle: "Website", status: "Waiting for you",
	icon: "preview", x: 20, y: 30, width: 320, height: 190, shape: "blob", seed: 17, wobble: 0.15, color: "accent", outline: "dashed" });
const element = item => { const { id, shape, ...props } = item; return { type: shape[0].toUpperCase() + shape.slice(1), props }; };
const add = item => [{ op: "add", path: `/elements/${item.id}`, value: element(item) }, { op: "add", path: "/elements/canvas/children/-", value: item.id }];
const fixture = t => {
	const directory = mkdtempSync(join(tmpdir(), "desk-home-"));
	const store = new HomeStore(directory);
	// Windows cannot remove a folder while a database in it is open, so everything a test opens there closes first.
	const closing = [];
	t.after(() => { for (const close of closing) close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
	return { directory, store, closing };
};

test("every patch keeps the live work on the canvas, and a scene drawn from quests starts afresh", t => {
	const { store } = fixture(t);
	store.set("work", [
		{ id: "asking", title: "Approval waiting", status: "Waiting on you", detail: "Approve?" },
		{ id: "working", computer: "laptop", view: "subagent-1", title: "Active agent", status: "Working", detail: "" },
	]);
	const required = store.required();
	assert.deepEqual(required.map(value => value.ref), [{ kind: "conversation", id: "asking" }, { kind: "conversation", id: "working", computer: "laptop", view: "subagent-1" }]);
	assert.throws(() => store.patch({ revision: 0, operations: add(item()) }), /Include every live work item/);
	const entries = required.map((value, index) => [`work-${index}`, element({ ...item(`work-${index}`), ...value })]);
	const elements = { canvas: { type: "Canvas", props: {}, children: entries.map(([id]) => id) }, ...Object.fromEntries(entries) };
	const scene = store.patch({ revision: 0, operations: [{ op: "replace", path: "/elements", value: elements }] });
	assert.deepEqual(homeItems(scene).map(value => value.ref), required.map(value => value.ref));
	assert.throws(() => store.patch({ revision: 1, operations: [{ op: "remove", path: "/elements/work-0" }, { op: "remove", path: "/elements/canvas/children/0" }] }), /Missing/);
	// A scene saved before quests were removed refers to them and would fail validation on every read.
	store.set("scene", { ...scene, spec: { ...scene.spec, elements: { ...scene.spec.elements, "work-0": element({ ...item("work-0"), ref: { kind: "quest", id: "q" } }) } } });
	assert.deepEqual(store.scene(), { ...emptyHomeScene(), revision: 1 });
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
	assert.ok([8, 9].includes((path.match(/ C /g) ?? []).length));
	assert.match(path, /^M [\d. -]+ C .* Z$/);
	const box = item(), coordinates = path.match(/-?\d+(?:\.\d+)?/g).map(Number);
	assert.ok(coordinates.every((value, index) => value >= -0.1 && value <= (index % 2 ? box.height : box.width) + 0.1), "the outline stays inside its box");
});

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
		}, waitForSession: async key => sessions.get(key), inputEvent() {}, drainInputs: managed => admitted.push(inputs.next(managed.view.key)), attachments: () => ({ check() {} }) };
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
	assert.throws(() => home.drag("missing", 1, 2), /workspace server/);
});

test("live-work changes coalesce into one persistent conversation turn", async t => {
	let now = 1000; t.mock.method(Date, "now", () => now);
	const { home, core, work, admitted } = controller(t);
	work.push({ id: "reviewer", computer: "laptop", title: "Review the result", status: "Working", detail: "" });
	await home.tick(); assert.equal(admitted.length, 0);
	work[0] = { ...work[0], title: "Review the final result" };
	now = 4001; await home.tick();
	assert.equal(admitted.length, 1);
	assert.match(admitted[0].input.command.text, /Review the final result/);
	assert.equal(core.sessions.size, 1);
	await home.tick(); assert.equal(admitted.length, 1);
});

test("scheduled Home alerts use an explicit phone delivery path", async t => {
	const notices = [], { home } = controller(t, async notice => { notices.push(notice); });
	const id = randomUUID(); home.store.request(id, { action: "notify", title: "Daily roundup", text: "A useful new article." });
	await home.tick(); await home.tick();
	assert.deepEqual(notices, [{ title: "Daily roundup", body: "A useful new article.", tag: `home:${id}`, session: "home" }]);
	assert.deepEqual(home.store.result(id), { value: { delivered: true, message: id } });
	assert.equal(home.snapshot().messages.at(-1).text, "A useful new article.");
});

test("home_scene names the layout faults Terra left on Jordan's canvas", () => {
	// Seen on Sydney: blobs grown to fit their words covered the tasks below them, and two area outlines ran into each other.
	const element = (type, props) => ({ type, props, children: [] });
	const scene = (elements) => ({ version: 1, revision: 1, preferences: {},
		spec: { root: "canvas", elements: { canvas: element("Canvas", {}), ...elements } } });
	const ref = { kind: "quest", id: "q" };
	const blob = { x: 60, y: 190, width: 210, height: 90, title: "HostHatch switch", icon: "globe", color: "amber", ref, seed: 1, wobble: 0.1 };
	assert.deepEqual(homeLayoutProblems(scene({
		land: element("Path", { x: 30, y: 90, color: "teal", d: "M10 20 C120 0 500 0 620 40 C640 200 630 400 560 430 C300 450 60 440 20 380 Z" }),
		cloud: element("Path", { x: 620, y: 100, color: "lilac", dashed: true, d: "M10 30 C150 -10 380 0 440 80 C450 250 400 340 220 350 C60 360 0 250 10 30 Z" }),
		hosthatch: element("Blob", blob),
		presentation: element("Text", { x: 65, y: 350, text: "Presentation", size: 17, color: "text", width: 210 }),
		dot: element("Shape", { x: 100, y: 592, kind: "ellipse", width: 8, height: 8, color: "muted" }),
		desks: element("Text", { x: 104, y: 550, text: "Office desks · 2 Nov", size: 13, color: "muted", align: "middle" }),
	})), ["hosthatch overlaps presentation", "areas land and cloud run into each other"]);
	assert.deepEqual(homeLayoutProblems(scene({
		hosthatch: element("Blob", { ...blob, height: 170 }),
		presentation: element("Text", { x: 65, y: 380, text: "Presentation", size: 17, color: "text" }),
		far: element("Text", { x: 1500, y: 900, text: "Psych · 17 Nov", size: 13, color: "muted" }),
	})), ["the drawing is 1540 by 727; keep it within about 1200 by 700"]);
});
