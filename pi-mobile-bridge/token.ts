import { randomBytes, timingSafeEqual } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function tokenPath(): string {
	return join(getAgentDir(), "mobile-bridge", "token");
}

function readToken(): string {
	const path = tokenPath();
	const stats = lstatSync(path);
	if (!stats.isFile() || stats.isSymbolicLink() ||
		(process.platform !== "win32" && (stats.mode & 0o077) !== 0)) {
		throw new Error("Phone token file must be a private regular file");
	}
	const token = readFileSync(path, "utf8").trim();
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid phone token file");
	return token;
}

export function phoneToken(): string {
	try { return readToken(); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const dir = join(getAgentDir(), "mobile-bridge");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, `.token-${randomBytes(8).toString("hex")}`);
	writeFileSync(temp, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
	try {
		linkSync(temp, tokenPath());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally { unlinkSync(temp); }
	return readToken();
}

export function resetPhoneToken(): string {
	const dir = join(getAgentDir(), "mobile-bridge");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = join(dir, `.token-${randomBytes(8).toString("hex")}`);
	writeFileSync(temp, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
	renameSync(temp, tokenPath());
	return readToken();
}

export function matchesPhoneToken(header: string | undefined): boolean {
	if (!header?.startsWith("Bearer ")) return false;
	const provided = Buffer.from(header.slice(7));
	const expected = Buffer.from(phoneToken());
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}
