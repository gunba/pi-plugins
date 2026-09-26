import assert from "node:assert/strict";
import test from "node:test";
import { link, mkdtemp, open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactStore, boundedText } from "../extensions/artifacts.ts";
import { literalMatches, page } from "../extensions/text.ts";

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

test("indexed pages preserve Unicode and malformed UTF-8 across byte checkpoints", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-index-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ArtifactStore(directory), source = join(directory, "source");
  const bytes = Buffer.concat([
    Buffer.from("a".repeat(65535) + "🙂é\n" + "界".repeat(30000)),
    Buffer.from([0xff, 0xe2, 0x82]),
    Buffer.from("end\n"),
    Buffer.from([0xf0, 0x9f]),
  ]);
  await writeFile(source, bytes);
  const id = await store.putFile(source), text = bytes.toString("utf8");
  for (const offset of [0, 65534, 65535, 65537, 90000, text.length - 3, text.length]) {
    for (const length of [1, 17, 128000]) assert.deepEqual(await store.readPage(id, offset, length), page(text, offset, length));
  }
  await assert.rejects(store.readPage(id, 65536), /Unicode/);
  await assert.rejects(store.readPage(id, -1), /offset/);
  assert.deepEqual(await store.readPage(await store.put("")), page(""));
  const before = await stat(store.path(id));
  await writeFile(store.path(id), Buffer.alloc(bytes.length, 97));
  await utimes(store.path(id), before.atime, before.mtime);
  await assert.rejects(store.readPage(id), /integrity/, "restoring mtime cannot hide changed bytes");
});

test("warm pages read bounded ranges and publication metadata changes are reverified", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-io-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ArtifactStore(directory), text = "a🙂é\n".repeat(600000);
  const id = await store.put(text);
  const handle = await open(store.path(id), "r"), prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const original = prototype.read;
  let bytes = 0, finishPublication = true;
  t.mock.method(prototype, "read", async function (...args) {
    const result = await original.apply(this, args);
    bytes += result.bytesRead;
    if (finishPublication) {
      finishPublication = false;
      const temporary = join(directory, ".capture-finishing");
      await link(store.path(id), temporary);
      await rm(temporary);
    }
    return result;
  });
  assert.deepEqual(await store.readPage(id, 0, 16000), page(text, 0, 16000));
  bytes = 0;
  for (const offset of [60000, 120000, 180000]) {
    assert.deepEqual(await new ArtifactStore(directory).readPage(id, offset, 16000), page(text, offset, 16000));
  }
  assert.ok(bytes < 400000, `warm pages reread ${bytes} bytes`);
});

test("search pages reuse an immutable result and recover after unreferenced cache cleanup", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-artifact-search-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ArtifactStore(directory), text = "skip\n".repeat(10000) + "needle🙂\nneedle end";
  const id = await store.put(text), matches = literalMatches(text, "needle");
  let offset = 0, restored = "", resultId;
  do {
    const result = await new ArtifactStore(directory).searchPage(id, "needle", offset, 7);
    restored += result.text; offset = result.next_offset; resultId = result.search_artifact;
  } while (offset !== null);
  assert.equal(restored, matches);
  await rm(store.path(resultId));
  assert.equal((await store.searchPage(id, "needle")).text, matches);
});
