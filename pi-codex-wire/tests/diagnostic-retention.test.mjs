import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Diagnostics, DIAGNOSTIC_PART_BYTES, DIAGNOSTIC_PARTS } from "../extensions/diagnostics.ts";
import { retainDiagnostics } from "../extensions/diagnostic-retention.ts";

test("rotation bounds a run and a retired writer cannot append again", async t => {
  const directory = await mkdtemp(join(tmpdir(), "wire-rotation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "run.jsonl"), logger = new Diagnostics(file);
  logger.write({ kind: "run", profile: "codex" });
  for (let i = 0; i < 45; i++) logger.write({ kind: "fixture", padding: "x".repeat(250000), sequence: i });
  const names = (await readdir(directory)).filter(name => !name.endsWith(".owner"));
  assert.equal(names.length, DIAGNOSTIC_PARTS);
  for (const name of names) {
    assert.ok((await stat(join(directory, name))).size <= DIAGNOSTIC_PART_BYTES);
    assert.equal(JSON.parse((await readFile(join(directory, name), "utf8")).split("\n")[0]).kind, "run");
  }
  logger.close();
  const before = await readFile(file, "utf8");
  logger.write({ kind: "late" });
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal(JSON.parse(await readFile(`${file}.owner`, "utf8")).closed, true);
});

test("retention leaves active and unowned logs intact", async t => {
  const directory = await mkdtemp(join(tmpdir(), "wire-retention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const active = new Diagnostics(join(directory, "active.jsonl"));
  const retired = new Diagnostics(join(directory, "retired.jsonl"));
  active.write({ kind: "run" }); retired.write({ kind: "run" }); retired.close();
  t.after(() => active.close());
  const old = new Date(Date.now() - 30 * 86400000);
  const unmanaged = join(directory, "unmanaged.jsonl");
  await writeFile(unmanaged, "unowned");
  for (const file of [active.path, retired.path, unmanaged]) await utimes(file, old, old);
  await retainDiagnostics(directory);
  await assert.rejects(stat(retired.path), { code: "ENOENT" });
  assert.ok((await stat(active.path)).isFile());
  assert.ok((await stat(unmanaged)).isFile());
});
