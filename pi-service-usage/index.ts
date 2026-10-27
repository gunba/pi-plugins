import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ServiceCharge {
	service: string; operation: string;
	/** USD at API prices, not a reconciled invoice. Omit when the charge is unknown. */
	cost?: number;
	estimated?: boolean;
	seconds?: number;
}
export interface ServiceTotal { service: string; calls: number; cost: number; estimated: number; unknown: number; seconds: number }
export interface ServiceUsageSnapshot { since?: number; totals: ServiceTotal[] }

/** Per-computer accounting shared by workers and the host. No prompts, audio, URLs, or credentials are stored. */
export class ServiceUsage {
	private readonly file: string;
	private db?: DatabaseSync;
	constructor(agentDir: string) { this.file = join(agentDir, "service-usage.sqlite"); }
	private open(): DatabaseSync {
		if (this.db) return this.db;
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const db = new DatabaseSync(this.file);
		try {
			chmodSync(this.file, 0o600);
			db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
				CREATE TABLE IF NOT EXISTS usage (day INTEGER NOT NULL, service TEXT NOT NULL, operation TEXT NOT NULL, firstAt INTEGER NOT NULL,
				calls INTEGER NOT NULL, cost REAL NOT NULL, estimated INTEGER NOT NULL, unknown INTEGER NOT NULL, seconds REAL NOT NULL,
				PRIMARY KEY(day,service,operation));`);
			return this.db = db;
		} catch (error) { db.close(); throw error; }
	}
	record(charge: ServiceCharge): void {
		const valid = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
		if (!charge.service || charge.service.length > 200 || !charge.operation || charge.operation.length > 100) throw new Error("Invalid service usage identity.");
		const at = Date.now(), known = valid(charge.cost);
		this.open().prepare(`INSERT INTO usage VALUES (?,?,?,?,1,?,?,?,?)
			ON CONFLICT(day,service,operation) DO UPDATE SET calls=calls+1,cost=cost+excluded.cost,
			estimated=estimated+excluded.estimated,unknown=unknown+excluded.unknown,seconds=seconds+excluded.seconds`)
			.run(Math.floor(at / 86_400_000), charge.service, charge.operation, at,
				known ? charge.cost! : 0, known && charge.estimated ? 1 : 0, known ? 0 : 1, valid(charge.seconds) ? charge.seconds! : 0);
	}
	snapshot(): ServiceUsageSnapshot {
		if (!this.db && !existsSync(this.file)) return { totals: [] };
		const db = this.open(), since = (db.prepare("SELECT MIN(firstAt) AS at FROM usage").get() as { at: number | null }).at;
		const totals = db.prepare(`SELECT service, SUM(calls) AS calls, SUM(cost) AS cost, SUM(estimated) AS estimated,
			SUM(unknown) AS unknown, SUM(seconds) AS seconds FROM usage GROUP BY service ORDER BY service`).all() as unknown as ServiceTotal[];
		return { ...(since === null ? {} : { since }), totals };
	}
	close(): void { this.db?.close(); this.db = undefined; }
}

/** Accounting failure must not turn a paid successful request into a retry. The caller surfaces the returned warning. */
export function recordServiceUsage(agentDir: string, charge: ServiceCharge): string | undefined {
	const usage = new ServiceUsage(agentDir);
	try { usage.record(charge); }
	catch { return "The service request finished, but its cost could not be recorded on this computer."; }
	finally { usage.close(); }
}
