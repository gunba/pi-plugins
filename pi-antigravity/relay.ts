import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, randomBytes, sign, X509Certificate } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";

/**
 * A local HTTPS proxy for the Antigravity server, for networks that inspect TLS.
 *
 * Netskope, on the work laptop, signs every site with RSM's own certificate authority. The server's Python (3.13 and
 * later, and urllib3) verifies chains strictly, and RSM's intermediate certificate has no Key Usage extension, which
 * strict verification requires: every request from the server failed in the TLS handshake, starting with the token
 * exchange that completes a sign-in, whatever certificates the server was told to trust. Node accepts that chain, so
 * the server's HTTPS goes through this proxy: Node verifies and reaches each site, and the server is shown it under a
 * certificate issued here, by a local authority the server trusts through its certificate bundle. The traffic still
 * passes the inspection. Every site is handled the same way, with or without inspection, so a laptop that moves
 * between networks needs nothing re-decided.
 */
export interface Relay {
	/** Settles once the proxy listens, or has failed to. */
	readonly ready: Promise<void>;
	/** The proxy's address, once it listens. */
	readonly url: string | undefined;
	/** The local authority's certificate (PEM), which the server must trust. */
	readonly authority: string;
}

const DAY_MS = 24 * 60 * 60_000;
const AUTHORITY_DAYS = 3650, LEAF_DAYS = 7;
const AUTHORITY_NAME = "Pi Antigravity relay (this computer only)";
/** Names a site on port 443, the only port the server uses; an address can't be certified with a name. */
const TARGET = /^((?=[a-z0-9.-]*[a-z])[a-z0-9-]+(?:\.[a-z0-9-]+)+):443$/i;

/**
 * Starts the proxy in this process. `trusted` are the certificates sites are verified against; the authority's file
 * is kept in `folder`. Throws if the authority can't be read or made.
 */
export function startRelay(folder: string, trusted: readonly string[]): Relay {
	const authority = localAuthority(folder), upstream = tls.createSecureContext({ ca: [...trusted] });
	const leafKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const leafKey = leafKeys.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
	const leaves = new Map<string, { context: tls.SecureContext; made: number }>();
	const leafContext = (host: string) => {
		let leaf = leaves.get(host);
		if (!leaf || Date.now() - leaf.made > DAY_MS) {
			const cert = certificate({ subject: name(host.slice(0, 64)), issuer: authority.name, publicKey: leafKeys.publicKey,
				signer: authority.key, issuerKeyId: authority.keyId, days: LEAF_DAYS, host });
			leaves.set(host, leaf = { context: tls.createSecureContext({ key: leafKey, cert }), made: Date.now() });
		}
		return leaf.context;
	};

	const server = http.createServer((_request, response) => response.writeHead(405).end());
	server.on("connect", (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
		socket.on("error", () => socket.destroy());
		const host = TARGET.exec(request.url ?? "")?.[1]?.toLowerCase();
		if (!host) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		try {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) socket.unshift(head);
			// HTTP/1.1 first: every site and inspecting proxy speaks it, and only a client that offers nothing else gets h2.
			const client = new tls.TLSSocket(socket, { isServer: true, secureContext: leafContext(host), ALPNProtocols: ["http/1.1", "h2"] });
			client.on("error", () => client.destroy());
			client.once("secure", () => {
				const site = tls.connect({ host, port: 443, servername: host, secureContext: upstream,
					...(client.alpnProtocol ? { ALPNProtocols: [client.alpnProtocol] } : {}) });
				// The bytes pass unchanged, so a server speaking h2 needs a site that chose it too. A site that chose
				// nothing speaks HTTP/1.1, as Netskope answers an offer of HTTP/1.1 alone.
				site.once("secureConnect", () => { if (client.alpnProtocol === "h2" && site.alpnProtocol !== "h2") site.destroy(); });
				splice(client, site);
			});
		} catch { socket.destroy(); }
	});
	const ready = new Promise<void>(resolve => {
		server.once("listening", () => resolve());
		server.once("error", () => { server.close(); resolve(); });
	});
	server.listen(0, "127.0.0.1");
	server.unref();
	return {
		authority: authority.pem,
		ready,
		get url() {
			const address = server.listening ? server.address() : null;
			return address && typeof address === "object" ? `http://127.0.0.1:${address.port}` : undefined;
		},
	};
}

function splice(a: net.Socket, b: net.Socket): void {
	a.pipe(b);
	b.pipe(a);
	for (const [one, other] of [[a, b], [b, a]] as const) {
		one.on("error", () => other.destroy());
		one.on("close", () => other.destroy());
	}
}

interface Authority { pem: string; key: KeyObject; keyId: Buffer; name: Buffer; expires: number }

/**
 * The local authority: its key and certificate, kept in one file beside the server's sign-in token and replaced a
 * month before the certificate expires.
 */
function localAuthority(folder: string): Authority {
	const file = join(folder, "relay-authority.pem"), current = readAuthority(file);
	if (current && current.expires - Date.now() > 30 * DAY_MS) return current;
	const { privateKey: key, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const pem = certificate({ subject: name(AUTHORITY_NAME), issuer: name(AUTHORITY_NAME), publicKey, signer: key, days: AUTHORITY_DAYS });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${key.export({ type: "pkcs8", format: "pem" }) as string}${pem}`, { mode: 0o600 });
	try {
		// Conversations starting together may each make one; the first in place is the one their servers all trust.
		if (current) renameSync(temp, file);
		else try { linkSync(temp, file); } catch (error) {
			const theirs = (error as NodeJS.ErrnoException).code === "EEXIST" ? readAuthority(file) : undefined;
			if (theirs) return theirs;
			renameSync(temp, file);
		}
	} finally { rmSync(temp, { force: true }); }
	return { pem, key, keyId: keyIdentifier(publicKey), name: name(AUTHORITY_NAME), expires: Date.now() + AUTHORITY_DAYS * DAY_MS };
}

function readAuthority(file: string): Authority | undefined {
	try {
		const text = readFileSync(file, "utf8");
		const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/.exec(text)?.[0];
		const keyPem = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/.exec(text)?.[0];
		if (!pem || !keyPem) return undefined;
		const key = createPrivateKey(keyPem), cert = new X509Certificate(pem);
		if (!cert.checkPrivateKey(key)) return undefined;
		return { pem, key, keyId: keyIdentifier(createPublicKey(key)), name: name(AUTHORITY_NAME), expires: Date.parse(cert.validTo) };
	} catch { return undefined; }
}

const keyIdentifier = (publicKey: KeyObject) => createHash("sha1").update(publicKey.export({ type: "spki", format: "der" })).digest();

// DER, as far as these certificates need it (RFC 5280).
const tlv = (tag: number, ...parts: Buffer[]) => {
	const body = Buffer.concat(parts), size = body.length;
	return Buffer.concat([Buffer.from([tag, ...(size < 0x80 ? [size] : size < 0x100 ? [0x81, size] : [0x82, size >> 8, size & 0xff])]), body]);
};
const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const oid = (dotted: string) => {
	const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number), bytes = [40 * first + second];
	for (const arc of rest) {
		const chunk = [arc & 0x7f];
		for (let value = arc >>> 7; value; value >>>= 7) chunk.unshift(0x80 | (value & 0x7f));
		bytes.push(...chunk);
	}
	return tlv(0x06, Buffer.from(bytes));
};
const time = (date: Date) => {
	const text = date.toISOString().replace(/[-:T]|\.\d+/g, "");
	return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(text.slice(2))) : tlv(0x18, Buffer.from(text));
};
const name = (commonName: string) => sequence(tlv(0x31, sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(commonName)))));
const extension = (id: string, critical: boolean, value: Buffer) =>
	sequence(oid(id), ...(critical ? [Buffer.from([0x01, 0x01, 0xff])] : []), tlv(0x04, value));

interface CertificateOptions { subject: Buffer; issuer: Buffer; publicKey: KeyObject; signer: KeyObject; days: number; host?: string; issuerKeyId?: Buffer }

/**
 * An ECDSA P-256 certificate that passes OpenSSL's strict checks: the authority's with Basic Constraints and Key
 * Usage (certificate and CRL signing) marked critical and a key identifier; a site's with Key Usage, server
 * authentication, its name as the only alternative name, and both key identifiers.
 */
function certificate(options: CertificateOptions): string {
	const spki = options.publicKey.export({ type: "spki", format: "der" });
	const serial = randomBytes(16);
	serial[0] = (serial[0]! & 0x3f) | 0x40;
	const algorithm = sequence(oid("1.2.840.10045.4.3.2"));
	const extensions = options.host === undefined ? [
		extension("2.5.29.19", true, sequence(Buffer.from([0x01, 0x01, 0xff]), tlv(0x02, Buffer.from([0])))),
		extension("2.5.29.15", true, Buffer.from([0x03, 0x02, 0x01, 0x06])),
		extension("2.5.29.14", false, tlv(0x04, keyIdentifier(options.publicKey))),
	] : [
		extension("2.5.29.19", true, sequence()),
		extension("2.5.29.15", true, Buffer.from([0x03, 0x02, 0x07, 0x80])),
		extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))),
		extension("2.5.29.17", false, sequence(tlv(0x82, Buffer.from(options.host)))),
		extension("2.5.29.14", false, tlv(0x04, keyIdentifier(options.publicKey))),
		extension("2.5.29.35", false, sequence(tlv(0x80, options.issuerKeyId!))),
	];
	const now = Date.now();
	const body = sequence(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), algorithm, options.issuer,
		sequence(time(new Date(now - 60 * 60_000)), time(new Date(now + options.days * DAY_MS))), options.subject, spki,
		tlv(0xa3, sequence(...extensions)));
	const der = sequence(body, algorithm, tlv(0x03, Buffer.from([0]), sign("sha256", body, options.signer)));
	return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}
