import { inflateRawSync } from "node:zlib";

/** The entries of a zip archive (Office files are zips of XML), read from its central directory. */
export function unzip(data: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	// The end-of-central-directory record is in the last 64 KiB (it may be followed by a comment).
	let end = -1;
	for (let at = data.length - 22; at >= Math.max(0, data.length - 65_557); at--) if (data.readUInt32LE(at) === 0x06054b50) { end = at; break; }
	if (end < 0) throw new Error("Not a zip archive.");
	const count = data.readUInt16LE(end + 10);
	let at = data.readUInt32LE(end + 16);
	for (let index = 0; index < count; index++) {
		if (data.readUInt32LE(at) !== 0x02014b50) throw new Error("Damaged zip directory.");
		const method = data.readUInt16LE(at + 10), compressed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24);
		const nameLength = data.readUInt16LE(at + 28), extraLength = data.readUInt16LE(at + 30), commentLength = data.readUInt16LE(at + 32);
		const local = data.readUInt32LE(at + 42), name = data.toString("utf8", at + 46, at + 46 + nameLength);
		at += 46 + nameLength + extraLength + commentLength;
		if (!wanted(name)) continue;
		if (data.readUInt32LE(local) !== 0x04034b50) throw new Error("Damaged zip entry.");
		const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28), body = data.subarray(start, start + compressed);
		if (method === 0) files.set(name, Buffer.from(body));
		else if (method === 8) files.set(name, inflateRawSync(body, { maxOutputLength: Math.max(size, 1) * 2 + 1024 }));
	}
	return files;
}
