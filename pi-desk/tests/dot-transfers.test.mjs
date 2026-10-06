import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { DotHttp } from "../src/host/dot-http.ts";
import { DotDownloadStore } from "../src/host/dot-download-store.ts";
import { dotAvatar } from "../src/host/dot-avatar.ts";

async function directory(t) {
	const path = await mkdtemp(join(tmpdir(), "desk-dot-transfer-"));
	t.after(() => rm(path, { recursive: true, force: true })); return path;
}
function transport(t, replies) {
	const requests = []; let authorizations = 0;
	const http = new DotHttp(async () => { authorizations++; return { token: "fixture-token", identity: { accountId: "fixture-account", userId: "owner", accountUserId: "owner" } }; }, undefined,
		(url, options, respond) => {
			const parts = [], record = { url: url.href, options, bytes: undefined }; requests.push(record);
			const reply = replies.shift(); assert.ok(reply, "No extra or retried requests");
			const request = new Writable({ autoDestroy: false, write(part, _encoding, done) { parts.push(Buffer.from(part)); done(); },
				final(done) {
					record.bytes = Buffer.concat(parts);
					const response = Readable.from(reply.parts ?? [reply.body ?? "{}"]);
					response.statusCode = reply.status ?? 200; response.headers = reply.headers ?? {};
					const abort = () => { response.destroy(Error("Cancelled fixture")); request.destroy(); };
					options.signal.addEventListener("abort", abort, { once: true });
					response.once("close", () => { options.signal.removeEventListener("abort", abort); request.destroy(); });
					respond(response); done();
				} });
			return request;
		});
	t.after(() => http.close()); return { http, requests, authorizations: () => authorizations };
}

test("multipart Dot upload streams the staged bytes after the durable dispatch hook", async t => {
	const dir = await directory(t), path = join(dir, "fixture.txt"), bytes = Buffer.from("fixture attachment\n");
	await writeFile(path, bytes);
	const { http, requests } = transport(t, [{ body: JSON.stringify({ id: "file" }) }]);
	let dispatched = 0;
	const value = await http.upload("/messaging/rooms/room/files", { path, name: 'report"\r\n.txt', mime: "text/plain", size: bytes.length }, {
		onDispatch() { dispatched++; assert.equal(requests.length, 0); },
	});
	assert.equal(value.id, "file"); assert.equal(dispatched, 1);
	const request = requests[0], boundary = request.options.headers["Content-Type"].split("boundary=")[1];
	assert.equal(request.options.headers.Authorization, "Bearer fixture-token");
	assert.equal(request.options.headers.Cookie, undefined);
	assert.equal(Number(request.options.headers["Content-Length"]), request.bytes.length);
	assert.match(request.bytes.toString(), /filename="report%22%0D%0A.txt"/);
	assert.ok(request.bytes.includes(bytes)); assert.ok(request.bytes.toString().endsWith(`\r\n--${boundary}--\r\n`));
});

test("asset redirects revalidate destinations and never forward account headers to the CDN", async t => {
	const { http, requests, authorizations } = transport(t, [
		{ status: 302, headers: { location: "https://files.oaiusercontent.com/fixture?signed=value" } },
		{ body: "bytes", headers: { "content-type": "text/plain" } },
		{ status: 302, headers: { location: "http://127.0.0.1/secret" } },
	]);
	const file = await http.asset("/backend-api/estuary/content?id=fixture", { maximum: 100 });
	assert.equal(file.bytes.toString(), "bytes"); assert.equal(authorizations(), 1);
	assert.equal(requests[0].options.headers.Authorization, "Bearer fixture-token");
	assert.equal(requests[1].options.headers.Authorization, undefined);
	assert.equal(requests[1].options.headers["ChatGPT-Account-Id"], undefined);
	assert.equal(requests[1].options.headers.Cookie, undefined);
	await assert.rejects(http.asset("https://files.oaiusercontent.com/redirect", { maximum: 100 }), /unexpected file destination/);
	assert.equal(requests.length, 3);
});

test("direct downloads remove partial files and serve bounded chunks without overwriting files", async t => {
	const dir = await directory(t), store = new DotDownloadStore(dir);
	t.after(() => store.close());
	const { http } = transport(t, [{ parts: [Buffer.alloc(5), Buffer.alloc(5)] }, { body: "data", headers: { "content-type": "text/plain" } }, { body: "new" }]);
	const partial = join(dir, "partial");
	await assert.rejects(http.download("https://files.oaiusercontent.com/large", partial, { maximum: 8 }), /did not complete/);
	await assert.rejects(readFile(partial), { code: "ENOENT" });
	const prepared = await store.create(async (path, maximum, signal) => ({ name: "../report.txt", ...await http.download("https://files.oaiusercontent.com/file", path, { maximum, signal }) }));
	assert.equal(prepared.name, "report.txt"); assert.equal(prepared.size, 4);
	const chunk = await store.chunk(prepared.id, 0); assert.equal(Buffer.from(chunk.data, "base64").toString(), "data"); assert.equal(chunk.next, 4);
	await store.release(prepared.id); assert.deepEqual(await readdir(join(dir, "downloads")), []);
	const existing = join(dir, "existing"); await writeFile(existing, "keep");
	await assert.rejects(http.download("https://files.oaiusercontent.com/file", existing, { maximum: 100 }), /did not complete/);
	assert.equal(await readFile(existing, "utf8"), "keep");
});

function png(width, headerOnly = false) {
	const chunk = (type, data) => { const payload = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), crc = Buffer.alloc(4);
		size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(payload)); return Buffer.concat([size, payload, crc]); };
	const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(width, 4); header[8] = 8; header[9] = 6;
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), ...(headerOnly ? [] : [chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * width)))]), chunk("IEND", Buffer.alloc(0))]);
}
test("avatars are bounded raster thumbnails and reject excessive dimensions before decoding", async () => {
	const result = await dotAvatar(png(256), "image/png");
	assert.ok(result.startsWith("data:image/png;base64,")); assert.ok(result.length < 100_100);
	assert.deepEqual(getImageDimensions(result.split(",")[1], "image/png"), { widthPx: 128, heightPx: 128 });
	await assert.rejects(dotAvatar(png(5000, true), "image/png"), /dimensions/);
	await assert.rejects(dotAvatar(Buffer.from("<svg/>"), "image/svg+xml"), /Unsupported/);
});
