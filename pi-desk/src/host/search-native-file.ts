import { createHash, type Hash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";

export const SEARCH_MAX_RECORD_BYTES = 64 * 1024 * 1024;
export interface NativeSearchRecord {
	/** Byte offsets include the terminating newline; an unfinished final record never advances the cursor. */
	start: number;
	end: number;
	data?: Buffer;
	oversize: boolean;
	prefixHash: string;
}
/** Verify the entire committed prefix: inode, size and boundary samples cannot detect an in-place edit followed by an append. */
export async function nativePrefixHash(file: FileHandle, length: number, signal: AbortSignal, progress?: (bytes: number) => void): Promise<Hash> {
	const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, length)));
	for (let position = 0; position < length;) {
		signal.throwIfAborted();
		const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, length - position), position);
		if (!bytesRead) throw Error("The native history changed while its indexed prefix was being checked.");
		hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; progress?.(bytesRead);
	}
	return hash;
}
/** Stream complete JSONL records from a fixed-size snapshot without buffering an oversized image-bearing line. The caller owns the file handle. */
export async function* nativeSearchRecords(file: FileHandle, start: number, end: number, hash: Hash, signal: AbortSignal,
	progress?: (bytes: number) => void): AsyncGenerator<NativeSearchRecord> {
	if (start >= end) return;
	let position = start, lineStart = start, bytes = 0, oversize = false, parts: Buffer[] = [];
	for (let readAt = start; readAt < end;) {
		signal.throwIfAborted();
		const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - readAt));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, readAt);
		if (!bytesRead) throw Error("The native history shrank while it was being indexed.");
		const chunk = buffer.subarray(0, bytesRead); readAt += bytesRead; progress?.(bytesRead);
		for (let from = 0; from < chunk.length;) {
			const newline = chunk.indexOf(10, from), through = newline < 0 ? chunk.length : newline + 1;
			const part = chunk.subarray(from, through);
			hash.update(part); position += part.length; bytes += part.length;
			if (bytes > SEARCH_MAX_RECORD_BYTES) { oversize = true; parts = []; }
			else if (!oversize) parts.push(part);
			if (newline >= 0) {
				const data = oversize ? undefined : parts.length === 1 ? parts[0] : Buffer.concat(parts, bytes);
				yield { start: lineStart, end: position, ...(data ? { data } : {}), oversize, prefixHash: hash.copy().digest("hex") };
				lineStart = position; parts = []; bytes = 0; oversize = false;
			}
			from = through;
		}
	}
}
/** Native headers contain identity and a folder, not transcript bodies. A missing or oversized header is not a searchable source. */
export async function nativeSearchHeaderLine(file: FileHandle): Promise<unknown> {
	const buffer = Buffer.allocUnsafe(64 * 1024), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
	const newline = buffer.subarray(0, bytesRead).indexOf(10);
	if (newline < 0) return;
	try { return JSON.parse(buffer.subarray(0, newline).toString("utf8").replace(/^\uFEFF/, "")); } catch { return; }
}
