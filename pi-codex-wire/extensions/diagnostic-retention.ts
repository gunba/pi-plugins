import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DIAGNOSTIC_PARTS } from "./diagnostics.ts";

const MAX_RETIRED_BYTES = 64 * 1024 * 1024;
const MAX_AGE_MS = 14 * 86400000;
const scans = new Map<string, Promise<void>>();

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Only sealed or dead owned runs are eligible. Unmarked logs are left alone. */
export function retainDiagnostics(directory: string): Promise<void> {
  const pending = scans.get(directory);
  if (pending) return pending;
  const task = prune(directory).finally(() => scans.delete(directory));
  scans.set(directory, task);
  return task;
}

async function prune(directory: string): Promise<void> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const retired = [];
  for (const name of names.filter(name => /^[\w.-]+\.jsonl\.owner$/.test(name))) {
    const owner = join(directory, name), base = owner.slice(0, -6);
    const info = await lstat(owner).catch(() => undefined);
    if (!info?.isFile()) continue;
    let lease: { pid: number; closed: boolean };
    try { lease = JSON.parse(await readFile(owner, "utf8")); }
    catch { continue; }
    if (!Number.isSafeInteger(lease?.pid) || lease.pid <= 0 || typeof lease.closed !== "boolean") continue;
    if (!lease.closed && alive(lease.pid)) continue;
    const files = [];
    let unknown = false;
    for (let part = 0; part < DIAGNOSTIC_PARTS; part++) {
      const path = part ? `${base}.${part}` : base;
      try {
        const stat = await lstat(path);
        if (!stat.isFile()) { unknown = true; break; }
        files.push({ path, stat });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") unknown = true; }
    }
    if (unknown) continue;
    retired.push({ owner, info, files, bytes: files.reduce((sum, file) => sum + file.stat.size, 0),
      time: files.length ? Math.max(...files.map(file => file.stat.mtimeMs)) : info.mtimeMs });
  }
  let retained = 0;
  for (const run of retired.sort((a, b) => b.time - a.time)) {
    if (Date.now() - run.time <= MAX_AGE_MS && retained + run.bytes <= MAX_RETIRED_BYTES) {
      retained += run.bytes;
      continue;
    }
    const current = await lstat(run.owner).catch(() => undefined);
    if (!current || current.ino !== run.info.ino || current.mtimeMs !== run.info.mtimeMs || current.size !== run.info.size) continue;
    let changed = false;
    for (const file of run.files) {
      const stat = await lstat(file.path).catch(() => undefined);
      if (stat?.isFile() && stat.ino === file.stat.ino && stat.mtimeMs === file.stat.mtimeMs && stat.size === file.stat.size)
        await unlink(file.path).catch(error => { if (error.code !== "ENOENT") throw error; });
      else if (stat) changed = true;
    }
    if (!changed) await unlink(run.owner).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
