import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectArtifacts } from "../cleanup/collector.mjs";
import { acquireArtifactAccess } from "../extensions/ownership.ts";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "artifact-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = join(directory, "tool-output"), main = join(directory, "sessions"), children = join(directory, "subagents", "sessions");
  await Promise.all([store, main, children].map(path => mkdir(path, { recursive: true })));
  async function artifact(text, recent = false) {
    const id = `sha256-${createHash("sha256").update(text).digest("hex")}`, file = join(store, `${id}.txt`);
    await writeFile(file, text);
    if (!recent) { const old = new Date(Date.now() - 3 * 86400000); await utimes(file, old, old); }
    return id;
  }
  const options = { directory: store, roots: [{ path: main }, { path: children }] };
  return { store, main, children, artifact, options };
}

test("cleanup retains main, child, nested and recent references; previews never delete", async t => {
  const f = await fixture(t);
  const child = await f.artifact("child"), nested = await f.artifact("nested");
  const main = await f.artifact(`original: ${nested}`), orphan = await f.artifact("orphan");
  const recentChild = await f.artifact("recent child");
  await f.artifact(`recent: ${recentChild}`, true);
  await writeFile(join(f.main, "main.jsonl"), JSON.stringify({ type: "message", content: main }) + "\n");
  await writeFile(join(f.children, "child.jsonl"), JSON.stringify({ type: "message", content: child }) + "\n");
  await writeFile(join(f.store, ".capture-active"), "partial");
  const preview = await collectArtifacts(f.options);
  assert.equal(preview.complete, true);
  assert.deepEqual(preview.candidates, [orphan]);
  assert.equal(preview.deleted.length, 0);
  assert.equal(preview.temporary, 1);
  const applied = await collectArtifacts({ ...f.options, apply: true });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.deleted, [orphan]);
  await assert.rejects(stat(join(f.store, `${orphan}.txt`)), { code: "ENOENT" });
  assert.equal(await readFile(join(f.store, `${nested}.txt`), "utf8"), "nested");
  assert.equal(await readFile(join(f.store, ".capture-active"), "utf8"), "partial");
});

test("incomplete or corrupt reference sources prevent every deletion", async t => {
  const f = await fixture(t), orphan = await f.artifact("orphan");
  const file = join(f.main, "main.jsonl");
  for (const text of ['{"type":"message"}', "{malformed\n"]) {
    await writeFile(file, text);
    const result = await collectArtifacts({ ...f.options, apply: true });
    assert.equal(result.complete, false);
    assert.equal(result.deleted.length, 0);
    assert.ok((await stat(join(f.store, `${orphan}.txt`))).isFile());
  }
});

test("active producers block cleanup even when their artifact has no saved reference", async t => {
  const f = await fixture(t), orphan = await f.artifact("orphan");
  await acquireArtifactAccess(f.store);
  const result = await collectArtifacts({ ...f.options, apply: true });
  assert.ok(result.activeWriters.includes(process.pid));
  assert.equal(result.applied, false);
  assert.equal(await readFile(join(f.store, `${orphan}.txt`), "utf8"), "orphan");
});

test("literal Unicode line separators inside long JSON strings do not split records", async t => {
  const f = await fixture(t), id = await f.artifact("referenced");
  await writeFile(join(f.main, "unicode.jsonl"),
    JSON.stringify({ type: "message", content: "head\u2028" + "x".repeat(120000) + "\u2029" + id }) + "\n");
  const result = await collectArtifacts(f.options);
  assert.equal(result.complete, true);
  assert.equal(result.reachable, 1);
  assert.equal(result.candidates.length, 0);
});
