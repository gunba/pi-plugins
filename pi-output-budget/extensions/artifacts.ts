import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const OUTPUT_CHARS = 16_000;
export const READ_CHARS = 32_000;
export const MAX_CHARS = 128_000;
const ID = /^sha256-[a-f0-9]{64}$/;

export class ArtifactStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  path(id: string): string {
    if (!ID.test(id)) throw new Error("Invalid output artifact ID");
    return join(this.directory, `${id}.txt`);
  }

  private async prepareDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Keep private output out of configuration sync even before managed
    // pi-sync ignore rules have been refreshed.
    try { await writeFile(join(this.directory, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }

  async put(text: string): Promise<string> {
    const id = `sha256-${createHash("sha256").update(text).digest("hex")}`;
    await this.prepareDirectory();
    const temporary = join(this.directory, `.capture-${randomUUID()}`);
    try {
      await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      await this.publish(temporary, id);
    } finally { await rm(temporary, { force: true }); }
    return id;
  }

  /** Copy a completed native log without loading the entire file into memory. */
  async putFile(source: string): Promise<string> {
    await this.prepareDirectory();
    const temporary = join(this.directory, `.capture-${randomUUID()}`);
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      await chmod(temporary, 0o600);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(temporary)) hash.update(chunk);
      const id = `sha256-${hash.digest("hex")}`;
      await this.publish(temporary, id);
      return id;
    } finally { await rm(temporary, { force: true }); }
  }

  private async publish(temporary: string, id: string): Promise<void> {
    // Atomic, no-overwrite publication: concurrent identical results can never
    // expose a partially written final artifact to another reader.
    try { await link(temporary, this.path(id)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await this.get(id);
    }
  }

  async get(id: string): Promise<string> {
    const bytes = await readFile(this.path(id));
    if (`sha256-${createHash("sha256").update(bytes).digest("hex")}` !== id) {
      throw new Error("Output artifact integrity check failed");
    }
    return bytes.toString("utf8");
  }
}

/** Offsets count UTF-16 code units, as in JS strings. Never split a surrogate pair. */
export function page(text: string, offset = 0, length = OUTPUT_CHARS) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error("Invalid character offset");
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_CHARS) throw new Error(`length must be 1..${MAX_CHARS}`);
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? "") && /[\uD800-\uDBFF]/.test(text[offset - 1] ?? "")) {
    throw new Error("Offset splits a Unicode character; use the returned next_offset");
  }
  let end = Math.min(text.length, offset + length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  if (end === offset && end < text.length) end += 2;
  return { text: text.slice(offset, end), next_offset: end < text.length ? end : null, total_chars: text.length };
}

export function literalMatches(text: string, query: string): string {
  if (!query) throw new Error("Search query must not be empty");
  return text.split("\n").flatMap((line, index) => line.includes(query) ? [`${index + 1}: ${line}`] : []).join("\n");
}

export async function boundedText(store: ArtifactStore, text: string, length = OUTPUT_CHARS) {
  const preview = page(text, 0, length);
  if (preview.next_offset === null) return { content: [{ type: "text" as const, text }], details: { outputBudgeted: true } };
  const artifact = await store.put(text);
  return {
    content: [{ type: "text" as const, text: `${preview.text}\n\n[Output truncated. Complete captured text: ${artifact}. Use read_artifact with offset=${preview.next_offset}. File: ${store.path(artifact)}]` }],
    details: { outputBudgeted: true, outputArtifact: artifact, next_offset: preview.next_offset, total_chars: text.length },
  };
}
