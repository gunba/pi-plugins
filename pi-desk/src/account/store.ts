import { open, readFile, rename, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { deviceKey, identifier, workspaceIdentity, type AccountConfiguration, type DeviceKind, type WorkspaceDevice } from "../shared/account.ts";
import { AccountError } from "./identity.ts";

interface AccountState { version: 1; account: string; revision: number; devices: WorkspaceDevice[] }

/** One writer owns the durable account directory; no transcript or token store. */
export class AccountStore {
	private state!: AccountState;
	private queue: Promise<unknown> = Promise.resolve();
	private release?: () => Promise<void>;
	private unavailable = false;
	private file: string;
	private config: AccountConfiguration;

	private constructor(directory: string, config: AccountConfiguration) {
		this.file = join(directory, "workspace.json");
		this.config = config;
	}
	static async open(directory: string, config: AccountConfiguration): Promise<AccountStore> {
		const store = new AccountStore(directory, config);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		store.release = await lockfile.lock(store.file, {
			realpath: false, stale: 30_000, update: 10_000,
			retries: { retries: 10, minTimeout: 500, maxTimeout: 3000 },
			onCompromised: () => { store.unavailable = true; },
		});
		try {
			let data: unknown;
			try { data = JSON.parse(await readFile(store.file, "utf8")); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read the account directory.");
				data = { version: 1, account: workspaceIdentity(config), revision: 0, devices: [] };
			}
			await store.restore(data);
			return store;
		} catch (error) { await store.release(); throw error; }
	}
	private async restore(value: unknown): Promise<void> {
		const state = value as AccountState;
		if (!state || state.version !== 1 || state.account !== workspaceIdentity(this.config)
			|| !Number.isSafeInteger(state.revision) || state.revision < 0
			|| !Array.isArray(state.devices) || state.devices.length > 1000) {
			throw new Error("Invalid account directory or account mismatch.");
		}
		const ids = new Set<string>();
		for (const entry of state.devices) {
			if (identifier(entry.id) !== entry.id || ids.has(entry.id)
				|| !["host", "browser"].includes(entry.kind) || typeof entry.name !== "string" || entry.name.length > 100
				|| ![entry.created, entry.seen].every(time => Number.isSafeInteger(time) && time >= 0)
				|| typeof entry.connected !== "boolean"
				|| entry.revoked !== undefined && (!Number.isSafeInteger(entry.revoked) || entry.revoked < 0)) {
				throw new Error("Invalid device in account directory.");
			}
			const publicKey = await deviceKey(entry.key);
			if (publicKey.thumbprint !== entry.thumbprint) throw new Error("Invalid device key in account directory.");
			entry.key = publicKey.key; ids.add(entry.id);
		}
		this.state = state;
	}
	assertAvailable(): void {
		if (this.unavailable) throw new AccountError(503, "account_directory_unavailable");
	}
	snapshot(): AccountState {
		this.assertAvailable();
		return structuredClone(this.state);
	}
	device(id: string): WorkspaceDevice {
		const device = this.snapshot().devices.find(device => device.id === id);
		if (!device) throw new AccountError(404, "device_not_found");
		if (device.revoked !== undefined) throw new AccountError(403, "device_revoked");
		return device;
	}
	async enrol(input: { id: string; kind: DeviceKind; name: string; key: unknown }): Promise<WorkspaceDevice> {
		const id = identifier(input.id), publicKey = await deviceKey(input.key);
		if (!["host", "browser"].includes(input.kind) || typeof input.name !== "string"
			|| !input.name.trim() || input.name.length > 100 || /[\u0000-\u001f\u007f]/.test(input.name)) {
			throw new AccountError(400, "invalid_device");
		}
		return this.change(state => {
			const existing = state.devices.find(device => device.id === id);
			if (existing) {
				if (existing.revoked !== undefined) throw new AccountError(403, "device_revoked");
				if (existing.thumbprint !== publicKey.thumbprint || existing.kind !== input.kind) {
					throw new AccountError(409, "device_identity_changed");
				}
				return existing;
			}
			if (state.devices.length >= 1000) throw new AccountError(409, "device_limit");
			const now = Date.now();
			const device: WorkspaceDevice = { id, kind: input.kind, name: input.name.trim(), ...publicKey,
				created: now, seen: now, connected: false };
			state.devices.push(device);
			return device;
		});
	}
	async touch(id: string, connected: boolean): Promise<void> {
		await this.change(state => {
			const device = state.devices.find(device => device.id === id);
			if (!device || device.revoked !== undefined) throw new AccountError(403, "device_unavailable");
			device.seen = Date.now(); device.connected = connected;
		});
	}
	async revoke(id: string): Promise<void> {
		await this.change(state => {
			const device = state.devices.find(device => device.id === id);
			if (!device) throw new AccountError(404, "device_not_found");
			device.revoked ??= Date.now(); device.connected = false;
		});
	}
	async rename(id: string, name: unknown): Promise<void> {
		if (typeof name !== "string" || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
			throw new AccountError(400, "invalid_device_name");
		}
		await this.change(state => {
			const device = state.devices.find(device => device.id === id);
			if (!device || device.revoked !== undefined) throw new AccountError(404, "device_not_found");
			device.name = name.trim();
		});
	}
	private change<T>(operation: (state: AccountState) => T): Promise<T> {
		const result = this.queue.then(async () => {
			const state = this.snapshot(), value = operation(state);
			state.revision++;
			const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
			try {
				const handle = await open(temporary, "wx", 0o600);
				try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
				finally { await handle.close(); }
				if (this.unavailable) throw new AccountError(503, "account_directory_unavailable");
				await rename(temporary, this.file);
				this.state = state;
				return structuredClone(value);
			} finally { await rm(temporary, { force: true }); }
		});
		this.queue = result.catch(() => {});
		return result;
	}
	async close(): Promise<void> {
		this.unavailable = true;
		await this.queue;
		await this.release?.();
		this.release = undefined;
	}
}
