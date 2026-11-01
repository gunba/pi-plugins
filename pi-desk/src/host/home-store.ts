import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { emptyHomeScene, homeItems, homeMovable, validateHomeElement, HomePatchSchema, patchHome, type HomeMessage, type HomeReference, type HomeRun, type HomeScene, type HomeWork } from "../shared/home.ts";
import { validateSpec } from "../../../pi-ui/agent-ui.ts";
import type { QuestCommand, QuestView } from "../shared/quests.ts";

const referenceKey = (ref: HomeReference): string | undefined => ref.kind === "quest" ? `quest:${ref.id}`
	: ref.kind === "conversation" ? JSON.stringify([ref.kind, ref.computer ?? "", ref.id, ref.view ?? ""]) : undefined;

/** Shared by the host and its Home worker. SQLite serializes scene patches and user drags across processes. */
export type HomeRequest = QuestCommand | { action: "notify"; title: string; text: string };
export class HomeStore {
	private db: DatabaseSync;
	constructor(directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(join(directory, "home.sqlite"));
		this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS home_values (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS home_messages (id TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS home_requests (id TEXT PRIMARY KEY, command TEXT NOT NULL, state TEXT NOT NULL, result TEXT);`);
	}
	get<T>(key: string): T | undefined {
		const row = this.db.prepare("SELECT value FROM home_values WHERE key=?").get(key) as { value: string } | undefined;
		return row ? JSON.parse(row.value) : undefined;
	}
	set(key: string, value: unknown): void { this.db.prepare("INSERT OR REPLACE INTO home_values VALUES (?,?)").run(key, JSON.stringify(value)); }
	scene(): HomeScene {
		const scene = this.get<HomeScene>("scene");
		if (!scene) return emptyHomeScene();
		if (scene.version !== 1 || !Number.isSafeInteger(scene.revision) || scene.revision < 0 || !scene.preferences || typeof scene.preferences !== "object" || Array.isArray(scene.preferences))
			throw Error("Home's saved scene has an unsupported format. Restore it before arranging more work.");
		validateSpec(scene.spec, validateHomeElement);
		for (const position of Object.values(scene.preferences)) if (!position || ![position.x, position.y].every(value => Number.isFinite(value) && Math.abs(value) <= 4000))
			throw Error("Home's saved position preference is invalid.");
		return scene;
	}
	private change(update: (scene: HomeScene) => HomeScene): HomeScene {
		this.db.exec("BEGIN IMMEDIATE");
		try { const scene = update(this.scene()); this.set("scene", scene); this.db.exec("COMMIT"); return scene; }
		catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	/** Required references come from the computed quest view, including reopened repeats, never raw saved quest states. */
	required(): { ref: HomeReference; title: string }[] {
		const view = this.get<QuestView>("quests");
		const quests = new Map([...(view?.quests.filter(quest => quest.state === "open") ?? []), ...(view?.upcoming ?? [])].map(quest => [quest.id, quest]));
		return [...quests.values()].map<{ ref: HomeReference; title: string }>(quest => ({ ref: { kind: "quest", id: quest.id }, title: quest.title }))
			.concat((this.get<HomeWork[]>("work") ?? []).map(work => ({ ref: { kind: "conversation", id: work.id, ...(work.computer ? { computer: work.computer } : {}), ...(work.view ? { view: work.view } : {}) } as HomeReference, title: work.title })));
	}
	private checkCoverage(scene: HomeScene): void {
		const view = this.get<QuestView>("quests");
		if (!view) throw Error("The real quest log has not loaded yet. Read home_quest before arranging Home.");
		const known = new Set([...view.quests, ...(view.upcoming ?? [])].map(quest => quest.id)), items = homeItems(scene);
		const unknown = items.filter(item => item.ref.kind === "quest" && !known.has(item.ref.id));
		if (unknown.length) throw Error(`Home contains quest references absent from the real log: ${unknown.map(item => item.id).join(", ")}. Do not use sample tasks.`);
		const present = new Set(items.map(item => referenceKey(item.ref))), missing = this.required().filter(item => !present.has(referenceKey(item.ref)));
		if (missing.length) throw Error(`Include every open/upcoming quest and live work item in the same patch. Missing: ${JSON.stringify(missing)}.`);
	}
	patch(raw: unknown, releasePositions: string[] = []): HomeScene {
		if (!Value.Check(HomePatchSchema, raw)) throw Error("Invalid Home patch: " + [...Value.Errors(HomePatchSchema, raw)].slice(0, 3).map(error => error.message).join("; "));
		return this.change(scene => {
			for (const id of releasePositions) delete scene.preferences[id];
			const next = patchHome(scene, raw);
			this.checkCoverage(next);
			return next;
		});
	}
	drag(id: string, x: number, y: number): HomeScene {
		if (![x, y].every(value => Number.isFinite(value) && Math.abs(value) <= 4000)) throw Error("Position is outside Home's canvas.");
		return this.change(scene => {
			const item = scene.spec.elements[id];
			if (!homeMovable(item)) throw Error("That item is no longer on Home.");
			item.props.x = x; item.props.y = y;
			Object.defineProperty(scene.preferences, id, { value: { x, y }, enumerable: true, configurable: true, writable: true });
			scene.revision++; return scene;
		});
	}
	message(message: HomeMessage): void { this.db.prepare("INSERT OR IGNORE INTO home_messages VALUES (?,?,?)").run(message.id, JSON.stringify(message), message.at); }
	messages(): HomeMessage[] { return (this.db.prepare("SELECT value FROM home_messages ORDER BY at DESC, rowid DESC LIMIT 80").all() as { value: string }[]).reverse().map(row => JSON.parse(row.value)); }
	run(run: HomeRun): void { this.set("run", run); }
	request(id: string, command: HomeRequest): void {
		const existing = this.db.prepare("SELECT command FROM home_requests WHERE id=?").get(id) as { command: string } | undefined;
		if (existing && existing.command !== JSON.stringify(command)) throw Error("Home request id already belongs to another command.");
		this.db.prepare("INSERT OR IGNORE INTO home_requests VALUES (?,?,'pending',NULL)").run(id, JSON.stringify(command));
	}
	pending(): { id: string; command: HomeRequest }[] {
		return (this.db.prepare("SELECT id, command FROM home_requests WHERE state='pending' ORDER BY rowid LIMIT 20").all() as { id: string; command: string }[])
			.map(row => ({ id: row.id, command: JSON.parse(row.command) }));
	}
	claim(id: string): boolean { return this.db.prepare("UPDATE home_requests SET state='applying' WHERE id=? AND state='pending'").run(id).changes === 1; }
	settle(id: string, result: unknown): void { this.db.prepare("UPDATE home_requests SET state='done', result=? WHERE id=?").run(JSON.stringify(result), id); }
	result(id: string): { value?: unknown; error?: string } | undefined {
		const row = this.db.prepare("SELECT result FROM home_requests WHERE id=?").get(id) as { result?: string } | undefined;
		return row?.result ? JSON.parse(row.result) : undefined;
	}
	recover(): void { this.db.prepare("UPDATE home_requests SET state='done', result=? WHERE state='applying'").run(JSON.stringify({ error: "Desk restarted during this change. Read the quest log before deciding whether to repeat it." })); }
	close(): void { this.db.close(); }
}
