import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newSecret, validSecret } from "../shared/secure-channel.ts";

interface Device { id: string; label: string; hash: string; created: number }
export interface RemoteDevice { id: string; label: string; key: string; created: number; expires?: number }
interface AccessData { version: 1; hostId: string; operator: string; devices: Device[]; remote?: RemoteDevice[] }
const digest = (value: string) => createHash("sha256").update(value).digest();
const secret = () => randomBytes(32).toString("base64url");

export class AccessStore {
	private data: AccessData;
	private file: string;
	private invitations = new Map<string, number>();
	private changes = new Set<(id: string) => void>();

	constructor(directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.file = join(directory, "access.json");
		this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) as AccessData
			: { version: 1, hostId: randomUUID(), operator: secret(), devices: [] };
		if (this.data.version !== 1 || !Array.isArray(this.data.devices) || typeof this.data.operator !== "string") {
			throw new Error("Invalid Pi Desk access file.");
		}
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

	get hostId(): string { return this.data.hostId; }

	devices(): { id: string; label: string; created: number; kind: string; pending?: boolean }[] {
		return [...this.data.devices.map(({ hash: _hash, ...device }) => ({ ...device, kind: "local" })),
			...(this.data.remote ?? []).map(device => ({ id: device.id, label: device.label, created: device.created,
				kind: "remote", pending: device.expires !== undefined }))];
	}

	inviteRemote(): RemoteDevice {
		this.data.remote = (this.data.remote ?? []).filter(device => !device.expires || device.expires > Date.now());
		if (this.data.remote.filter(device => device.expires).length >= 8) throw new Error("There are already eight unused invitations.");
		const device: RemoteDevice = { id: randomUUID(), key: newSecret(), created: Date.now(), label: "Invitation", expires: Date.now() + 10 * 60_000 };
		this.data.remote.push(device); this.save();
		return { ...device };
	}

	remote(id: string): RemoteDevice | undefined {
		const device = this.data.remote?.find(device => device.id === id);
		return device && (!device.expires || device.expires > Date.now()) ? { ...device } : undefined;
	}

	claimRemote(id: string, invitationKey: string, persistentKey: string, label: string): void {
		const device = this.data.remote?.find(device => device.id === id);
		if (!validSecret(persistentKey)) throw new Error("Invalid device key.");
		if (device && !device.expires && timingSafeEqual(digest(device.key), digest(persistentKey))) return;
		if (!device?.expires || device.expires < Date.now() || device.key !== invitationKey || !validSecret(persistentKey)) {
			throw new Error("This invitation expired or was already used.");
		}
		device.key = persistentKey;
		device.label = label.slice(0, 100) || "Browser";
		delete device.expires;
		this.save();
	}

	onRevoke(handler: (id: string) => void): () => void {
		this.changes.add(handler); return () => this.changes.delete(handler);
	}

	hasDevice(id: string): boolean {
		return this.data.devices.some(device => device.id === id) ||
			!!this.data.remote?.some(device => device.id === id && !device.expires);
	}

	revoke(id: string): void {
		this.data.devices = this.data.devices.filter(device => device.id !== id);
		this.data.remote = this.data.remote?.filter(device => device.id !== id);
		this.save();
		for (const handler of this.changes) handler(id);
	}
}
