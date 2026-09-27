import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Device { id: string; label: string; hash: string; created: number }
interface AccessData { version: 1; operator: string; devices: Device[] }
const digest = (value: string) => createHash("sha256").update(value).digest();
const secret = () => randomBytes(32).toString("base64url");

export class AccessStore {
	private data: AccessData;
	private file: string;
	private invitations = new Map<string, number>();

	constructor(directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.file = join(directory, "access.json");
		this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) as AccessData
			: { version: 1, operator: secret(), devices: [] };
		if (this.data.version !== 1 || !Array.isArray(this.data.devices) || typeof this.data.operator !== "string") {
			throw new Error("Invalid Pi Desk access file.");
		}
		// Retain local recovery access only; discard obsolete remote grants from disk.
		this.data = { version: 1, operator: this.data.operator, devices: this.data.devices };
		this.save();
	}

	private save(): void {
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, this.file);
	}

	isOperator(token: string): boolean { return timingSafeEqual(digest(token), digest(this.data.operator)); }

	invite(): string {
		for (const [token, expires] of this.invitations) if (expires < Date.now()) this.invitations.delete(token);
		if (this.invitations.size >= 8) this.invitations.delete(this.invitations.keys().next().value!);
		const token = secret();
		this.invitations.set(digest(token).toString("hex"), Date.now() + 10 * 60_000);
		return token;
	}

	pair(token: string, label: string): { token: string; device: Omit<Device, "hash"> } {
		const hash = digest(token).toString("hex");
		const expires = this.invitations.get(hash);
		if (!expires || expires < Date.now()) throw new Error("This invitation expired or was already used.");
		this.invitations.delete(hash);
		const credential = secret();
		const device = { id: randomUUID(), label: label.slice(0, 100) || "Browser", created: Date.now() };
		this.data.devices.push({ ...device, hash: digest(credential).toString("hex") });
		this.save();
		return { token: credential, device };
	}

	authenticate(token: string): string | undefined {
		const hash = digest(token).toString("hex");
		return this.data.devices.find(device => device.hash === hash)?.id;
	}

	devices(): { id: string; label: string; created: number; kind: string }[] {
		return this.data.devices.map(({ hash: _hash, ...device }) => ({ ...device, kind: "local" }));
	}

	hasDevice(id: string): boolean {
		return this.data.devices.some(device => device.id === id);
	}

	revoke(id: string): void {
		this.data.devices = this.data.devices.filter(device => device.id !== id);
		this.save();
	}
}
