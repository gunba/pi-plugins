import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore, boundedText, literalMatches, page } from "../extensions/artifacts.ts";

test("immutable artifacts deduplicate, survive reopening and reject traversal/tampering", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifacts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ArtifactStore(directory);
  const text = "snapshot\n".repeat(10_000);
  const first = await boundedText(store, text, 100);
  const id = first.details.outputArtifact;
  assert.equal(await readFile(join(directory, ".gitignore"), "utf8"), "*\n");
  assert.equal(await store.put(text), id);
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => store.put(text)));
  assert.ok(concurrent.every(value => value === id));
  assert.equal(await new ArtifactStore(directory).get(id), text);
  const source = join(directory, "completed-native.log");
  await writeFile(source, text);
  assert.equal(await store.putFile(source), id);
  await rm(source);
  assert.equal(await store.get(id), text);
  assert.throws(() => store.path("../../private"), /Invalid/);
  await writeFile(store.path(id), "tampered");
  await assert.rejects(store.get(id), /integrity/);
  await assert.rejects(store.put(text), /integrity/);
});

test("character pagination handles huge single lines and Unicode without gaps", () => {
  const text = "a🙂é".repeat(20_000);
  let offset = 0, restored = "";
  do {
    const result = page(text, offset, 17);
    restored += result.text;
    offset = result.next_offset;
  } while (offset !== null);
  assert.equal(restored, text);
  assert.throws(() => page("🙂", 1), /Unicode/);
  assert.throws(() => page(text, -1), /offset/);
  assert.throws(() => page(text, 0, 128001), /length/);
});

test("literal search covers the entire captured output", () => {
  const text = "early\n".repeat(10000) + "late [a-z]*\n";
  assert.equal(literalMatches(text, "[a-z]*"), "10001: late [a-z]*");
  assert.throws(() => literalMatches(text, ""), /empty/);
});
