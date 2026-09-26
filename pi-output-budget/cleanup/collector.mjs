import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { activeArtifactWriters, withArtifactGate } from "../extensions/ownership.ts";

const signature = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const artifactName = /^(sha256-[a-f0-9]{64})\.txt$/;
const DAY = 86400000;

async function parallelScan(tasks) {
  if (!tasks.length) return [];
  const groups = Array.from({ length: Math.min(availableParallelism(), tasks.length) }, () => []);
  tasks.forEach((task, index) => groups[index % groups.length].push(task));
  return (await Promise.all(groups.map(group => new Promise(resolve => {
    const worker = new Worker(new URL("./scan-worker.mjs", import.meta.url), { workerData: group });
    let reported = false;
    worker.once("message", rows => { reported = true; resolve(rows); });
    worker.once("error", () => { reported = true; resolve(group.map(task => ({ ...task, problem: "Scanner worker failed" }))); });
    worker.once("exit", code => {
      if (!reported) resolve(group.map(task => ({ ...task, problem: `Scanner worker exited (${code})` })));
    });
  })))).flat();
}

/** Caller supplies every session root, including any custom --session-dir paths. */
export async function collectArtifacts({ directory, roots, apply = false, minimumAgeMs = DAY }) {
  directory = resolve(directory);
  return withArtifactGate(directory, async () => {
    const report = {
      complete: true, applied: false, sessionFiles: 0, artifactFiles: 0, reachable: 0, recent: 0,
      missingReferences: 0, temporary: 0, candidateBytes: 0, deletedBytes: 0,
      candidates: [], deleted: [], activeWriters: await activeArtifactWriters(directory), issues: [],
    };
    const problem = (path, reason) => { report.complete = false; report.issues.push({ path, reason }); };
    if (apply && report.activeWriters.length) {
      problem(directory, "Stop all Pi writer processes before applying cleanup");
      return report;
    }
    const directories = new Map(), tasks = [], artifacts = new Map(), visited = new Set();
    async function walk(path, optional = false, explicit = false) {
      path = resolve(path);
      if (visited.has(path)) return;
      visited.add(path);
      try {
        const info = await lstat(path, { bigint: true });
        if (info.isDirectory()) {
          directories.set(path, signature(info));
          const names = await readdir(path);
          for (const name of names) await walk(join(path, name));
        } else if (info.isSymbolicLink()) {
          directories.set(path, signature(info));
          await walk(await realpath(path), false, explicit);
        } else if (info.isFile() && (explicit || path.endsWith(".jsonl"))) tasks.push({ path });
      } catch (error) {
        if (!(optional && error.code === "ENOENT")) problem(path, error.code ?? "Cannot inspect source");
      }
    }
    for (const root of roots) await walk(root.path, root.optional, true);
    report.sessionFiles = tasks.length;
    try {
      directories.set(directory, signature(await lstat(directory, { bigint: true })));
      const physical = await realpath(directory);
      directories.set(physical, signature(await lstat(physical, { bigint: true })));
      for (const name of await readdir(directory)) {
        if (name.startsWith(".capture-")) report.temporary++;
        const match = artifactName.exec(name);
        if (!match) continue;
        const path = join(directory, name), info = await lstat(path, { bigint: true });
        if (!info.isFile()) { problem(path, "Artifact is not a regular file"); continue; }
        artifacts.set(match[1], { path, signature: signature(info), size: Number(info.size), mtime: Number(info.mtimeMs) });
        tasks.push({ path, id: match[1] });
      }
    } catch (error) { problem(directory, error.code ?? "Cannot inspect artifact directory"); }
    report.artifactFiles = artifacts.size;
    const rows = await parallelScan(tasks), rootsFound = new Set(), graph = new Map();
    for (const row of rows) {
      if (row.problem) { problem(row.path, row.problem); continue; }
      if (row.id) {
        if (artifacts.get(row.id).signature !== row.signature) problem(row.path, "Artifact changed during inventory");
        graph.set(row.id, row.references);
      }
      else for (const id of row.references) rootsFound.add(id);
    }
    // Recent captures are roots too: their outgoing links must survive the grace period.
    for (const [id, file] of artifacts) {
      if (Date.now() - file.mtime < minimumAgeMs) {
        report.recent++;
        rootsFound.add(id);
      }
    }
    const marked = new Set(), missing = new Set(), queue = [...rootsFound];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      if (marked.has(id) || missing.has(id)) continue;
      if (!artifacts.has(id)) { missing.add(id); continue; }
      marked.add(id);
      queue.push(...(graph.get(id) ?? []));
    }
    report.reachable = marked.size;
    report.missingReferences = missing.size;
    for (const [id, file] of artifacts) {
      if (marked.has(id)) continue;
      report.candidates.push(id);
      report.candidateBytes += file.size;
    }
    // The gate excludes new producers; snapshots also detect uncoordinated edits.
    for (const [path, before] of [...directories, ...rows.filter(row => row.signature).map(row => [row.path, row.signature])]) {
      try { if (signature(await lstat(path, { bigint: true })) !== before) problem(path, "Source changed after scan"); }
      catch (error) { problem(path, error.code ?? "Source disappeared after scan"); }
    }
    report.activeWriters = await activeArtifactWriters(directory);
    if (apply && report.complete && !report.activeWriters.length) {
      for (const id of report.candidates) {
        const file = artifacts.get(id);
        // Check each deletion against its scanned version as well.
        if (signature(await lstat(file.path, { bigint: true })) !== file.signature) {
          problem(file.path, "Artifact changed before deletion"); break;
        }
        await unlink(file.path);
        report.deleted.push(id);
        report.deletedBytes += file.size;
      }
      report.applied = report.complete;
    }
    return report;
  });
}
