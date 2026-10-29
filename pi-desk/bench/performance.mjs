// Performance checks with numbers that do not depend on the machine, compared with bench/baseline.json.
//
//   node bench/performance.mjs           print the metrics
//   node bench/performance.mjs --check   also fail when a metric is worse than the baseline allows
//   node bench/performance.mjs --update  write the current metrics as the new baseline
//
// Run `npm run build` first: the bundle sizes are read from dist/client.
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applySessionChanges, applyStateChanges, sessionChanges, stateChanges } from "../src/shared/session-patch.ts";
import { SearchStore } from "../src/host/search-store.ts";
import { SEARCH_EMBEDDING_DIMENSIONS } from "../src/host/search-embedder.ts";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const baselineFile = join(root, "bench", "baseline.json");

/** A seeded random source, so the synthetic workload is the same on every run. */
function random(seed) {
	return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Two minutes of a workspace as browsers receive it, shaped like a recording of a busy one: 12 conversations, one of
 * them running 160 agents; about 1.6 conversation changes, 26 transcript events and one state change in 40 seconds
 * each second.
 */
function workload() {
	const rand = random(7), pick = list => list[Math.floor(rand() * list.length)], text = n => "abcdefghij klmnopqrstuvwxyz ".repeat(Math.ceil(n / 28)).slice(0, n);
	const tools = Array.from({ length: 98 }, (_, i) => ({ name: `tool_${i}`, description: text(420) }));
	const session = (key, agents) => ({
		key, state: "ready", computer: "c1", cwd: `/home/user/projects/${key}`, created: 1, title: `Conversation ${key}`,
		snapshot: { id: `snap-${key}`, activity: "idle", model: { provider: "anthropic", id: "m", name: "Model" }, tools, usage: { tokens: 1000, cost: 1 }, context: { tokens: 1000, percent: 1 } },
		ui: { generation: `gen-${key}`, views: [
			{ id: "work", kind: "work", title: "Work", revision: 1, data: [{ id: "plan", label: "Plan", status: "1 of 9", summary: text(490), detail: text(1264), tone: "working" }, { id: "agents", label: "Agents", status: "0", summary: text(300), detail: text(600), tone: "idle" }] },
			{ id: "pi-usage", kind: "details", title: "Usage", data: { items: [{ label: "5h", value: "72%" }, { label: "Week", value: "40%" }] } },
			...Array.from({ length: agents }, (_, i) => ({ id: `agent:${i.toString(16).padStart(8, "0")}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`, kind: "details", title: `agent ${i}`, data: { status: "Working", tool: "bash", detail: text(700) } })),
		] },
	});
	let sessions = Array.from({ length: 12 }, (_, i) => session(`s${i}`, i === 0 ? 160 : i < 4 ? 4 : 0));
	const state = members => ({ name: "computer", release: { version: "0.0.0", api: 8 }, cwd: "/home/user", parties: Array.from({ length: 20 }, (_, i) => ({ id: `party-${i}`, name: text(40), members: i === 0 ? members : 3, detail: text(1200) })), sessions });
	const events = [{ type: "state", state: state(1) }];
	let revision = 1, message = 0;
	for (let tenth = 1; tenth <= 1200; tenth++) {
		if (tenth % 400 === 0) events.push({ type: "state", state: state(1 + tenth / 400) });
		if (rand() < 0.16) {
			const before = sessions[0], next = structuredClone(before), roll = rand();
			if (roll < 0.5) { const view = pick(next.ui.views.slice(2)); view.data.status = rand() < 0.5 ? "Working" : "Idle"; view.data.detail = text(600 + Math.floor(rand() * 200)); }
			else if (roll < 0.95) { const work = next.ui.views[0]; work.revision = ++revision; work.data[0].status = `${revision % 9} of 9`; }
			else { next.snapshot.usage.tokens += 1000; next.snapshot.context.percent++; }
			sessions = [next, ...sessions.slice(1)];
			events.push({ type: "session", session: next });
		}
		for (let i = 0; i < 2.6; i += 1) {
			if (rand() > 0.87) continue;
			const id = `live:${(message % 31).toString(16).padStart(8, "0")}-6a68-49fa-8c93-211a59bb261f`, source = `${(message % 31).toString(16).padStart(8, "0")}-b93e-4fc1-a049-3472f5135205`, roll = rand();
			const event = roll < 0.67 ? { type: "delta", generation: "gen-s0", id, revision: ++message, index: 0, kind: "text", text: text(3 + Math.floor(rand() * 8)), truncated: false }
				: roll < 0.84 ? { type: "chat", generation: "gen-s0", message: { id, role: "tool", toolName: "bash", timestamp: 1, revision: ++message, order: 1, blocks: [{ type: "text", text: text(600 + Math.floor(rand() * 1200)) }] } }
				: { type: "block", generation: "gen-s0", id, revision: ++message, index: 1, block: { type: "toolCall", id: "call", name: "bash", arguments: text(700) } };
			events.push({ type: "worker", key: "s0", message: { type: "transcript", source, event } });
		}
	}
	return events;
}

/** Bytes per minute a browser receives, by connection: the local event stream, the relay, and a compact browser. */
function wire() {
	const events = workload(), minutes = 2, out = {};
	for (const mode of ["local", "relay", "compact"]) {
		let host, sent = new Map(), browserState, browserSessions = new Map(), bytes = 0;
		for (const [index, event] of events.entries()) {
			let wire = event;
			if (mode !== "local" && event.type === "state") {
				const changes = mode === "compact" && host ? stateChanges(host, event.state, sent) : undefined;
				sent = new Map(event.state.sessions.map(session => [session.key, session])); host = event.state;
				if (changes) wire = { type: "state_patch", changes };
			} else if (mode !== "local" && event.type === "session") {
				const before = sent.get(event.session.key); sent.set(event.session.key, event.session);
				if (before) wire = { type: "session_patch", key: event.session.key, changes: sessionChanges(before, event.session, [], mode === "compact") };
			}
			const text = JSON.stringify(wire);
			if (index > 0) bytes += Buffer.byteLength(text);
			// The browser's side: every conversation and state must come out exactly as the host had it.
			const got = JSON.parse(text);
			const rebuilt = got.type === "session_patch" ? { type: "session", session: applySessionChanges(browserSessions.get(got.key), got.changes) }
				: got.type === "state_patch" ? { type: "state", state: applyStateChanges(browserState, got.changes, browserSessions) } : got;
			if (rebuilt.type === "state") { browserState = rebuilt.state; browserSessions = new Map(rebuilt.state.sessions.map(session => [session.key, session])); }
			else if (rebuilt.type === "session") browserSessions.set(rebuilt.session.key, rebuilt.session);
			if (event.type !== "worker" && !isDeepStrictEqual(rebuilt, event)) throw new Error(`${mode}: event ${index} (${event.type}) did not rebuild exactly`);
		}
		out[`wire_${mode}_kb_per_minute`] = Math.round(bytes / 1024 / minutes);
	}
	return out;
}

/** The client bundle as served: raw and gzip bytes of its scripts and styles. */
function bundle() {
	const directory = join(root, "dist", "client", "assets"), out = { bundle_js_kb: 0, bundle_js_gzip_kb: 0, bundle_css_gzip_kb: 0 };
	let files;
	try { files = readdirSync(directory); } catch { throw new Error("dist/client is missing: run `npm run build` first."); }
	for (const file of files) {
		const data = readFileSync(join(directory, file)), gzip = gzipSync(data).length;
		if (file.endsWith(".js")) { out.bundle_js_kb += data.length; out.bundle_js_gzip_kb += gzip; }
		else if (file.endsWith(".css")) out.bundle_css_gzip_kb += gzip;
	}
	for (const key of Object.keys(out)) out[key] = Math.round(out[key] / 1024);
	return out;
}

/**
 * The search store's routine work against one full read of its passages, the same measure on any machine: expiry runs
 * every minute, and the host asks for the last scan and the worker for passages to embed on every change, so none of
 * them may read every passage.
 */
function search() {
	const directory = mkdtempSync(join(tmpdir(), "desk-bench-search-")), store = new SearchStore(join(directory, "index.sqlite"));
	try {
		for (let s = 0; s < 300; s++) {
			const file = { file: join(directory, `${s}.jsonl`), id: `source-${s}`, stamp: "bench", offset: 0, ordinal: 0, anchor: "", seen: "scan" };
			const source = store.registerFile(file, { id: file.id, session: file.id, title: file.id, project: directory, kind: "primary", updated: 1 }, false);
			store.append({ ...file, offset: 1, ordinal: 200 }, source.generation, Array.from({ length: 200 }, (_, e) => ({ id: `e${e}`, ordinal: e + 1,
				passages: [{ start: 0, role: e % 3 ? "assistant" : "tool", text: `Passage ${s}.${e} about ${["search", "relay", "budget", "worker"][e % 4]} performance and its numbers ${e * 7}.` }] })), { complete: true });
		}
		const median = run => { const times = []; for (let i = 0; i < 9; i++) { const t = performance.now(); run(); times.push(performance.now() - t); } return times.sort((a, b) => a - b)[4]; };
		const scan = median(() => store.db.prepare("SELECT sum(length(p.entry)) FROM passages p").get());
		const scope = { local: true }, vector = new Float32Array(SEARCH_EMBEDDING_DIMENSIONS); vector[0] = 1;
		for (let batch; (batch = store.pending(scope, 4096)).length;) store.putVectors(batch.map(item => ({ id: item.id, hash: item.hash, vector })));
		return { search_expiry_vs_scan: +(median(() => store.expire()) / scan).toFixed(3), search_last_scan_vs_scan: +(median(() => store.lastScan(scope)) / scan).toFixed(3),
			search_pending_vs_scan: +(median(() => store.pending(scope, 16)) / scan).toFixed(3) };
	} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

/** How much worse than the baseline each metric may be before --check fails. */
const allowed = key => key.startsWith("search_") ? { absolute: 0.25 } : { relative: 0.05 };

const metrics = { ...wire(), ...bundle(), ...search() };
const mode = process.argv[2];
if (mode === "--update") { writeFileSync(baselineFile, `${JSON.stringify(metrics, null, "\t")}\n`); console.log("Baseline updated:", metrics); process.exit(0); }
const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
let failed = false;
for (const [key, value] of Object.entries(metrics)) {
	const was = baseline[key], limit = allowed(key), worse = limit.absolute !== undefined ? value > limit.absolute : was !== undefined && value > was * (1 + limit.relative);
	if (mode === "--check" && worse) failed = true;
	console.log(`${worse ? "WORSE" : "ok   "} ${key.padEnd(28)} ${String(value).padStart(8)}  baseline ${was ?? "-"}`);
}
if (failed) { console.error("A performance metric is worse than bench/baseline.json allows. Fix it, or run --update if the change is intended."); process.exit(1); }
