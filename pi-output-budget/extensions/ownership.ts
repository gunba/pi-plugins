import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";

type Owners = { ready: Map<string, Promise<void>>; files: Set<string> };
const key = Symbol.for("pi.output-budget.writers.v1");
const global = globalThis as typeof globalThis & { [key]?: Owners };
const owners = global[key] ??= (() => {
  const state: Owners = { ready: new Map(), files: new Set() };
  process.once("exit", () => {
    for (const file of state.files) { try { unlinkSync(file); } catch { /* Dead PID markers are recoverable. */ } }
  });
  return state;
})();

/** Serialize offline maintenance with first access by new producer processes. */
export async function withArtifactGate<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    realpath: false, lockfilePath: join(directory, ".maintenance.lock"),
    retries: { retries: 60, minTimeout: 100, maxTimeout: 1000 },
  });
  try { return await operation(); }
  finally { await release(); }
}

/** Process lifetime covers deferred session persistence and SDK children too. */
export function acquireArtifactAccess(directory: string): Promise<void> {
  const path = resolve(directory);
  let ready = owners.ready.get(path);
  if (!ready) {
    ready = withArtifactGate(path, async () => {
      try { await writeFile(join(path, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await mkdir(join(path, ".writers"), { recursive: true, mode: 0o700 });
      const marker = join(path, ".writers", `${process.pid}-${randomUUID()}.lock`);
      await writeFile(marker, "", { flag: "wx", mode: 0o600 });
      owners.files.add(marker);
    }).catch(error => { owners.ready.delete(path); throw error; });
    owners.ready.set(path, ready);
  }
  return ready;
}

export async function activeArtifactWriters(directory: string): Promise<Array<number | "unknown">> {
  let entries;
  try { entries = await readdir(join(directory, ".writers"), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const active = new Set<number | "unknown">();
  for (const entry of entries) {
    const match = /^([1-9]\d*)-[a-f0-9-]{36}\.lock$/.exec(entry.name);
    if (!entry.isFile() || !match || !Number.isSafeInteger(Number(match[1]))) { active.add("unknown"); continue; }
    const pid = Number(match[1]);
    try { process.kill(pid, 0); active.add(pid); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") active.add(pid); }
  }
  return [...active];
}
