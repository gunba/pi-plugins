import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

const signature = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const pattern = /sha256-[a-f0-9]{64}/g;
function references(value, found) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") for (const id of item.matchAll(pattern)) found.add(id[0]);
    else if (item && typeof item === "object") for (const child of Object.values(item)) pending.push(child);
  }
}

async function scan(task) {
  const result = { path: task.path, id: task.id, references: [] };
  try {
    const before = await lstat(task.path, { bigint: true });
    if (!before.isFile()) throw new Error("Not a regular file");
    const found = new Set();
    if (task.id) {
      const hash = createHash("sha256");
      let tail = "";
      for await (const chunk of createReadStream(task.path)) {
        hash.update(chunk);
        const text = tail + chunk.toString("latin1");
        references(text, found);
        tail = text.slice(-70);
      }
      if (`sha256-${hash.digest("hex")}` !== task.id) throw new Error("Artifact integrity check failed");
    } else {
      const stream = createReadStream(task.path, { encoding: "utf8" });
      let fragments = [], count = 0;
      try {
        for await (const chunk of stream) {
          let start = 0;
          // JSONL separates records with LF. readline also splits literal U+2028
          // and U+2029 on newer Node versions, which are legal inside JSON strings.
          for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
            fragments.push(chunk.slice(start, end));
            const line = fragments.join("");
            fragments = [];
            start = end + 1;
            count++;
            if (!line.trim()) continue;
            let entry;
            try { entry = JSON.parse(line); }
            catch { throw new Error(`Invalid JSON at line ${count}`); }
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid record at line ${count}`);
            references(entry, found);
          }
          if (start < chunk.length) fragments.push(chunk.slice(start));
        }
      } finally { stream.destroy(); }
      if (!count || fragments.length) throw new Error("Incomplete session file");
    }
    const after = await lstat(task.path, { bigint: true });
    if (signature(before) !== signature(after)) throw new Error("File changed during scan");
    Object.assign(result, { signature: signature(after), references: [...found] });
  } catch (error) {
    result.problem = error.code ?? error.message;
  }
  return result;
}

const results = [];
for (const task of workerData) results.push(await scan(task));
parentPort.postMessage(results);
