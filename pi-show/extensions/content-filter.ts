/**
 * Git's long-running clean filter for Desk's change snapshots (gitattributes "filter.<driver>.process"): one process per
 * `git add` turns each Office file into its content and each other binary file into a fingerprint (content.ts).
 * Run by git as `node content-filter.ts`; it never fails a file, so a snapshot never stores a file whole by accident.
 */
import { encodeContent } from "./content.ts";

const MAX = 65516;
// Input arrives in chunks; packets are at most 64 KiB, so only the head of the queue is ever merged.
const chunks: Buffer[] = [];
let available = 0, waiting: (() => void) | undefined, ended = false;
process.stdin.on("data", (chunk: Buffer) => { chunks.push(chunk); available += chunk.length; waiting?.(); });
process.stdin.on("end", () => { ended = true; waiting?.(); });
function take(length: number): Buffer {
	while (chunks[0]!.length < length) chunks.splice(0, 2, Buffer.concat([chunks[0]!, chunks[1]!]));
	const head = chunks[0]!, result = head.subarray(0, length);
	if (head.length === length) chunks.shift(); else chunks[0] = head.subarray(length);
	available -= length;
	return result;
}

/** The next packet: a payload, or null for a flush packet; undefined at the end of input. */
async function packet(): Promise<Buffer | null | undefined> {
	for (;;) {
		if (available >= 4) {
			const length = parseInt(take(4).toString("latin1"), 16);
			if (length === 0) return null;
			while (available < length - 4 && !ended) { await new Promise<void>(done => { waiting = done; }); waiting = undefined; }
			return available >= length - 4 ? take(length - 4) : undefined;
		}
		if (ended) return undefined;
		await new Promise<void>(done => { waiting = done; });
		waiting = undefined;
	}
}
/** Text packets up to the next flush. */
async function lines(): Promise<string[] | undefined> {
	const result: string[] = [];
	for (;;) {
		const next = await packet();
		if (next === undefined) return result.length ? result : undefined;
		if (next === null) return result;
		result.push(next.toString("utf8").replace(/\n$/, ""));
	}
}
const encode = (payload: Buffer) => Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, "0"), "latin1"), payload]);
const text = (line: string) => encode(Buffer.from(`${line}\n`));
const FLUSH = Buffer.from("0000", "latin1");
const write = (data: Buffer) => new Promise<void>(done => { if (process.stdout.write(data)) done(); else process.stdout.once("drain", () => done()); });

async function main(): Promise<void> {
	const hello = await lines();
	if (!hello?.includes("git-filter-client") || !hello.includes("version=2")) process.exit(1);
	await write(Buffer.concat([text("git-filter-server"), text("version=2"), FLUSH]));
	await lines();
	await write(Buffer.concat([text("capability=clean"), FLUSH]));
	for (;;) {
		const request = await lines();
		if (!request) return;
		const command = request.find(line => line.startsWith("command="))?.slice(8), path = request.find(line => line.startsWith("pathname="))?.slice(9) ?? "";
		const parts: Buffer[] = [];
		for (let next = await packet(); next; next = await packet()) parts.push(next);
		if (command !== "clean") { await write(Buffer.concat([text("status=error"), FLUSH])); continue; }
		const content = encodeContent(path, Buffer.concat(parts));
		const out: Buffer[] = [text("status=success"), FLUSH];
		for (let at = 0; at < content.length; at += MAX) out.push(encode(content.subarray(at, at + MAX)));
		out.push(FLUSH, FLUSH);
		await write(Buffer.concat(out));
	}
}
void main();
