import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

const CHUNK = 64 * 1024;

/** Same UTF-8 decoding and line format as literalMatches, without retaining whole lines. */
export async function searchToFile(source: FileHandle, destination: FileHandle, query: string): Promise<string> {
  if (!query) throw new Error("Search query must not be empty");
  await destination.truncate(0);
  const hash = createHash("sha256");
  let outputPosition = 0, buffered = 0, parts: string[] = [];
  const flush = async () => {
    const bytes = Buffer.from(parts.join(""), "utf8");
    parts = []; buffered = 0;
    hash.update(bytes);
    let written = 0;
    while (written < bytes.length) {
      const result = await destination.write(bytes, written, bytes.length - written, outputPosition + written);
      if (!result.bytesWritten) throw new Error("Could not write artifact search result");
      written += result.bytesWritten;
    }
    outputPosition += written;
  };
  const append = (text: string): Promise<void> | undefined => {
    parts.push(text); buffered += text.length;
    if (buffered >= CHUNK) return flush();
  };
  if (!query.includes("\n")) {
    const buffer = Buffer.allocUnsafe(CHUNK), copy = Buffer.allocUnsafe(CHUNK);
    let position = 0, lineStart = 0, line = 1, matches = 0;
    let decoder: StringDecoder | undefined, tail = "", matched = false;
    const accept = (bytes: Buffer, end: boolean) => {
      if (matched) return;
      if (!end) decoder ??= new StringDecoder("utf8");
      const text = tail + (decoder ? decoder.write(bytes) + (end ? decoder.end() : "") : bytes.toString("utf8"));
      matched = text.includes(query);
      tail = matched || query.length === 1 ? "" : text.slice(1 - query.length);
    };
    const emit = async (end: number, chunkStart: number, bytes: Buffer) => {
      let pending = append(`${matches++ ? "\n" : ""}${line}: `);
      if (pending) await pending;
      if (lineStart >= chunkStart) {
        pending = append(bytes.subarray(lineStart - chunkStart, end - chunkStart).toString("utf8"));
        if (pending) await pending;
      } else {
        // A very long line needs a second bounded read, not a growing line buffer.
        const decode = new StringDecoder("utf8");
        for (let offset = lineStart; offset < end;) {
          const { bytesRead } = await source.read(copy, 0, Math.min(CHUNK, end - offset), offset);
          if (!bytesRead) throw new Error("Artifact changed during search");
          offset += bytesRead;
          pending = append(decode.write(copy.subarray(0, bytesRead)));
          if (pending) await pending;
        }
        pending = append(decode.end());
        if (pending) await pending;
      }
    };
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const bytes = buffer.subarray(0, bytesRead);
      let cursor = 0;
      while (cursor < bytes.length) {
        const newline = bytes.indexOf(10, cursor), end = newline < 0 ? bytes.length : newline;
        accept(bytes.subarray(cursor, end), newline >= 0);
        if (newline < 0) break;
        if (matched) await emit(position + end, position, bytes);
        line++; lineStart = position + end + 1;
        decoder = undefined; tail = ""; matched = false; cursor = end + 1;
      }
      position += bytesRead;
    }
    accept(Buffer.alloc(0), true);
    if (matched) await emit(position, position, Buffer.alloc(0));
  }
  await flush();
  return `sha256-${hash.digest("hex")}`;
}
