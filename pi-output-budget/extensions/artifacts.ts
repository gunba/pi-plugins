import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, link, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { artifactPage, artifactSearch, artifactText, artifactVersion } from "./artifact-reader.ts";
import { OUTPUT_CHARS, page } from "./text.ts";
import { acquireArtifactAccess } from "./ownership.ts";

const ID = /^sha256-[a-f0-9]{64}$/;
const searches = new Map<string, string>();
const pendingSearches = new Map<string, Promise<string>>();

export class ArtifactStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }

  path(id: string): string {
    if (!ID.test(id)) throw new Error("Invalid output artifact ID");
    return join(this.directory, `${id}.txt`);
  }

  private async prepareDirectory(): Promise<void> {
    await acquireArtifactAccess(this.directory);
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
      await artifactVersion(this.path(id), id);
    }
  }

  async get(id: string): Promise<string> {
    const path = this.path(id);
    await this.prepareDirectory();
    return artifactText(path, id);
  }

  async readPage(id: string, offset = 0, length = OUTPUT_CHARS) {
    const path = this.path(id);
    await this.prepareDirectory();
    return artifactPage(path, id, offset, length);
  }

  async searchPage(id: string, query: string, offset = 0, length = OUTPUT_CHARS) {
    if (!query) throw new Error("Search query must not be empty");
    const path = this.path(id);
    await this.prepareDirectory();
    const version = await artifactVersion(path, id);
    // String.includes uses UTF-16 units; UTF-8 would collapse lone surrogates into U+FFFD.
    const key = `${path}\0${version}\0${createHash("sha256").update(query, "utf16le").digest("hex")}`;
    let found = searches.get(key);
    if (found) {
      try {
        const result = await this.readPage(found, offset, length);
        searches.delete(key); searches.set(key, found);
        return { ...result, search_artifact: found };
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    let pending = pendingSearches.get(key);
    if (!pending) {
      pending = this.search(path, id, query).then(result => {
        searches.delete(key); searches.set(key, result);
        while (searches.size > 64) searches.delete(searches.keys().next().value!);
        return result;
      }).finally(() => pendingSearches.delete(key));
      pendingSearches.set(key, pending);
    }
    found = await pending;
    return { ...await this.readPage(found, offset, length), search_artifact: found };
  }

  private async search(path: string, id: string, query: string): Promise<string> {
    const temporary = join(this.directory, `.capture-${randomUUID()}`);
    try {
      const file = await open(temporary, "wx", 0o600);
      let result: string;
      try { result = await artifactSearch(path, id, query, file); }
      finally { await file.close(); }
      await this.publish(temporary, result);
      return result;
    } finally { await rm(temporary, { force: true }); }
  }
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
