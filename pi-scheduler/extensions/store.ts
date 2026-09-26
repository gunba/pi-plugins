import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

const requireSQLite = createRequire(import.meta.url);

export type ScheduledMessage = {
  id: string;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  createdAt: number;
  dueAt: number;
  message: string;
  delivery: "steer" | "followUp";
};

function validateMessage(value: unknown): ScheduledMessage {
  if (!value || typeof value !== "object") throw new Error("Invalid scheduler record");
  const v = value as ScheduledMessage;
  if (typeof v.id !== "string" || !v.id || typeof v.sessionId !== "string" || !v.sessionId
    || typeof v.message !== "string" || typeof v.cwd !== "string"
    || (v.sessionFile !== undefined && typeof v.sessionFile !== "string")
    || !Number.isFinite(v.createdAt) || !Number.isFinite(v.dueAt)
    || (v.delivery !== "steer" && v.delivery !== "followUp")) throw new Error("Invalid scheduler record");
  return v;
}

// Session-scoped SQLite transactions serialize schedule/cancel/claim, including
// across processes. SQLite rolls back interrupted transactions itself.
export class ScheduleStore {
  readonly owner = randomUUID();
  readonly directory: string;
  readonly sessionId: string;
  private readonly file: string;
  private database?: DatabaseSync;
  private closed = false;
  constructor(directory: string, sessionId: string) {
    this.directory = directory;
    this.sessionId = sessionId;
    this.file = join(directory, `${createHash("sha256").update(sessionId).digest("hex")}.sqlite`);
  }

  private connection(create = false, importing = false): DatabaseSync | undefined {
    if (this.closed) throw new Error("Schedule store is closed");
    const legacy = join(this.directory, "scheduled-messages.json");
    if (!importing && existsSync(legacy)) throw new Error(`Scheduler migration required: stop Pi processes using the JSON scheduler, then run /schedule migrate. Pending reminders remain in ${legacy}.`);
    if (this.database) return this.database;
    if (!create && !existsSync(this.file)) return undefined;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const { DatabaseSync } = requireSQLite("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(this.file);
    try {
      db.exec("PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL");
      db.exec(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL,
        owner TEXT, pid INTEGER,
        CHECK ((owner IS NULL) = (pid IS NULL))
      )`);
      this.database = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private transaction<T>(operation: (db: DatabaseSync) => T, create = false, importing = false): T | undefined {
    const db = this.connection(create, importing);
    if (!db) return undefined;
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = operation(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.database?.prepare("UPDATE messages SET owner=NULL, pid=NULL WHERE owner=?").run(this.owner);
    } finally {
      this.database?.close();
      this.database = undefined;
      this.closed = true;
    }
  }

  /** One-time, restartable cutover. Normal operation never reads JSON. */
  static migrateLegacy(directory: string): { count: number; backup: string } {
    const legacy = join(directory, "scheduled-messages.json");
    const original = readFileSync(legacy, "utf8");
    const data = JSON.parse(original) as { version?: unknown; messages?: unknown };
    if (data.version !== 2 || !Array.isArray(data.messages)) throw new Error("Unsupported legacy scheduler format");
    const groups = new Map<string, ScheduledMessage[]>();
    for (const value of data.messages) {
      const message = validateMessage(value);
      const group = groups.get(message.sessionId) ?? [];
      group.push(message);
      groups.set(message.sessionId, group);
    }
    for (const [session, messages] of groups) {
      const store = new ScheduleStore(directory, session);
      try {
        store.transaction((db) => {
          for (const message of messages) {
            const payload = JSON.stringify(message);
            const existing = db.prepare("SELECT payload FROM messages WHERE id=?").get(message.id);
            if (existing && existing.payload !== payload) throw new Error(`Conflicting reminder ${message.id}; migration stopped without replacing it`);
            db.prepare("INSERT OR IGNORE INTO messages(id, payload) VALUES (?, ?)").run(message.id, payload);
          }
        }, true, true);
      } finally { store.close(); }
    }
    if (readFileSync(legacy, "utf8") !== original) throw new Error("Legacy scheduler changed during migration; stop old Pi processes and retry");
    const backup = `${legacy}.${randomUUID()}.bak`;
    renameSync(legacy, backup);
    return { count: data.messages.length, backup };
  }

  private entries(db: DatabaseSync): ScheduledMessage[] {
    return db.prepare("SELECT id, payload FROM messages").all().map((row) => {
      const v = validateMessage(JSON.parse(String(row.payload)));
      if (v.id !== row.id || v.sessionId !== this.sessionId) {
        throw new Error(`Invalid scheduler record ${row.id}`);
      }
      return v;
    }).sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt);
  }

  list(): ScheduledMessage[] {
    const db = this.connection();
    return db ? this.entries(db) : [];
  }

  add(message: ScheduledMessage): void {
    if (message.sessionId !== this.sessionId) throw new Error("Scheduler session mismatch");
    this.transaction((db) => {
      db.prepare("INSERT INTO messages(id, payload) VALUES (?, ?)").run(message.id, JSON.stringify(message));
    }, true);
  }

  cancel(selector: string): { cancelled: ScheduledMessage[]; ambiguous: boolean } {
    return this.transaction((db) => {
      const entries = this.entries(db);
      const all = /^(all|clear)$/i.test(selector);
      const matches = entries.filter((entry) => all || entry.id.startsWith(selector));
      if (!all && matches.length > 1) return { cancelled: [], ambiguous: true };
      const cancelled = matches.filter((entry) => db.prepare("DELETE FROM messages WHERE id=? AND owner IS NULL").run(entry.id).changes > 0);
      return { cancelled, ambiguous: false };
    }) ?? { cancelled: [], ambiguous: false };
  }

  claimDue(now: number, admitted: ReadonlySet<string>): ScheduledMessage[] {
    return this.transaction((db) => {
      // Acknowledgements come from the durable session transcript, never from
      // sendMessage's void return or message_end (which precedes persistence).
      for (const id of admitted) db.prepare("DELETE FROM messages WHERE id=?").run(id);
      for (const row of db.prepare("SELECT DISTINCT pid FROM messages WHERE owner IS NOT NULL").all()) {
        try { process.kill(Number(row.pid), 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          db.prepare("UPDATE messages SET owner=NULL, pid=NULL WHERE pid=?").run(row.pid);
        }
      }
      return this.entries(db).filter((entry) => entry.dueAt <= now
        && db.prepare("UPDATE messages SET owner=?, pid=? WHERE id=? AND owner IS NULL")
          .run(this.owner, process.pid, entry.id).changes > 0);
    }) ?? [];
  }

  release(id?: string): void {
    this.transaction((db) => {
      db.prepare("UPDATE messages SET owner=NULL, pid=NULL WHERE owner=? AND (? IS NULL OR id=?)")
        .run(this.owner, id ?? null, id ?? null);
    });
  }
}
