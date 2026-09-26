import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { MAX_CHARS, page } from "./text.ts";

const CHUNK = 64 * 1024;
const CACHE_BYTES = 16 * 1024 * 1024;
type Index = { points: Float64Array; chars: number };
type Cached = { stamp: string; index: Index };
type ReadVersion<T> = (file: FileHandle, index: Index, version: string) => Promise<T>;
type Cache = { entries: Map<string, Cached>; pending: Map<string, Promise<Index>>; bytes: number };
const cacheKey = Symbol.for("pi.output-budget.artifact-index.v1");
const shared = globalThis as typeof globalThis & { [cacheKey]?: Cache };
const cache = shared[cacheKey] ??= { entries: new Map(), pending: new Map(), bytes: 0 };

function changed(): NodeJS.ErrnoException {
  return Object.assign(new Error("Artifact changed during retrieval"), { code: "ARTIFACT_CHANGED" });
}

async function stamp(file: FileHandle): Promise<string> {
  const s = await file.stat({ bigint: true });
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}

function evict(key: string): void {
  const old = cache.entries.get(key);
  if (old) cache.bytes -= old.index.points.byteLength;
  cache.entries.delete(key);
}

// Keep a possible unfinished UTF-8 sequence with the next chunk. Invalid bytes
// otherwise retain Buffer.toString's replacement-character behaviour.
function boundary(bytes: Buffer): number {
  let start = bytes.length - 1;
  while (start >= Math.max(0, bytes.length - 4) && (bytes[start]! & 0xc0) === 0x80) start--;
  const lead = bytes[start] ?? 0;
  const length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
  return length > bytes.length - start ? start : bytes.length;
}

async function build(file: FileHandle, id: string, version: string): Promise<Index> {
  const size = (await file.stat()).size;
  const hash = createHash("sha256"), points = [0, 0];
  let position = 0, bytes = 0, chars = 0;
  let tail: Buffer = Buffer.alloc(0);
  while (position < size) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK, size - position));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (!bytesRead) throw changed();
    position += bytesRead;
    const raw = chunk.subarray(0, bytesRead);
    hash.update(raw);
    const joined = tail.length ? Buffer.concat([tail, raw]) : raw;
    const end = boundary(joined);
    bytes += end;
    chars += joined.subarray(0, end).toString("utf8").length;
    if (end) points.push(bytes, chars);
    tail = Buffer.from(joined.subarray(end));
  }
  if (tail.length) {
    bytes += tail.length;
    chars += tail.toString("utf8").length;
    points.push(bytes, chars);
  }
  if (`sha256-${hash.digest("hex")}` !== id) throw new Error(`Artifact failed integrity verification: ${id}`);
  if (await stamp(file) !== version) throw changed();
  return { points: new Float64Array(points), chars };
}

async function indexed<T>(path: string, id: string, use: ReadVersion<T>): Promise<T> {
  try { return await withVersion(path, id, use); }
  catch (error) {
    // Finishing atomic publication removes a temporary hard link, changing ctime.
    if ((error as NodeJS.ErrnoException).code !== "ARTIFACT_CHANGED") throw error;
    return withVersion(path, id, use);
  }
}

async function withVersion<T>(path: string, id: string, use: ReadVersion<T>): Promise<T> {
  const file = await open(path, "r");
  const key = `${resolve(path)}\0${id}`;
  try {
    const version = await stamp(file), cached = cache.entries.get(key);
    let index: Index;
    if (cached?.stamp === version) {
      index = cached.index;
      cache.entries.delete(key);
      cache.entries.set(key, cached);
    } else {
      evict(key);
      const pendingKey = `${key}\0${version}`;
      let pending = cache.pending.get(pendingKey);
      if (!pending) {
        pending = build(file, id, version).then(result => {
          if (result.points.byteLength <= CACHE_BYTES) {
            evict(key);
            cache.entries.set(key, { stamp: version, index: result });
            cache.bytes += result.points.byteLength;
            while (cache.entries.size > 64 || cache.bytes > CACHE_BYTES) evict(cache.entries.keys().next().value!);
          }
          return result;
        }).finally(() => cache.pending.delete(pendingKey));
        cache.pending.set(pendingKey, pending);
      }
      index = await pending;
    }
    const result = await use(file, index, version);
    if (await stamp(file) !== version) {
      evict(key);
      throw changed();
    }
    return result;
  } finally { await file.close(); }
}

/** Character checkpoint at or immediately before the requested offset. */
function floor(points: Float64Array, offset: number): number {
  let low = 0, high = points.length / 2 - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (points[mid * 2 + 1]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low * 2;
}

export async function artifactPage(path: string, id: string, offset: number, length: number) {
  return indexed(path, id, async (file, index) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > index.chars) throw new Error("Invalid character offset");
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_CHARS) throw new Error(`length must be 1..${MAX_CHARS}`);
    const start = floor(index.points, Math.max(0, offset - 1));
    const target = Math.min(index.chars, offset + length + 2);
    let end = floor(index.points, target);
    if (index.points[end + 1]! < target) end += 2;
    const byteStart = index.points[start]!, charStart = index.points[start + 1]!;
    const buffer = Buffer.allocUnsafe(index.points[end]! - byteStart);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await file.read(buffer, read, buffer.length - read, byteStart + read);
      if (!bytesRead) throw changed();
      read += bytesRead;
    }
    const result = page(buffer.toString("utf8"), offset - charStart, length);
    const next = offset + result.text.length;
    return { text: result.text, next_offset: next < index.chars ? next : null, total_chars: index.chars };
  });
}

export const artifactVersion = (path: string, id: string): Promise<string> =>
  indexed(path, id, async (_file, _index, version) => version);

export const artifactText = (path: string, id: string): Promise<string> =>
  indexed(path, id, file => file.readFile("utf8"));
