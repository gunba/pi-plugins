import type { HostEvent, HostState } from "../shared/protocol.ts";
import type { ApiResponse } from "../shared/relay-protocol.ts";
import { deviceKey, identifier, workspaceIdentity, type WorkspaceDevice } from "../shared/account.ts";
import type { BrowserAccount } from "./account.ts";
import { RemoteClient, RemoteError } from "./remote.ts";
import { sessionKey, type WorkspaceEvent, type WorkspaceState } from "./workspace.ts";
import { surfaces } from "./surfaces.tsx";
import { BlobPool, decodeBase64, type BlobLease } from "./blob-pool.ts";
import { API_HEADER, API_VERSION, RELEASE, apiMatches, upgradeMessage } from "../shared/release.ts";

export class ApiError extends Error {
	status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}
interface ComputerConnection { device: WorkspaceDevice; client: RemoteClient; state?: HostState; epoch: number; unlisten: () => void }
const remotes = new Map<string, ComputerConnection>();
let mode: "local" | "account" | undefined;
let account: BrowserAccount | undefined;
let directoryError: string | undefined;
let generation = 0, directoryTimer: ReturnType<typeof setInterval> | undefined;
let syncing: Promise<void> | undefined, unwatchAccount: (() => void) | undefined;
const consumers = new Set<(event: WorkspaceEvent, accepted?: () => void) => void>();
const upgrades = new Set<(message: string) => void>();
let upgrade: string | undefined;
function incompatible(message: string): ApiError {
	upgrade = message;
	for (const handler of upgrades) handler(message);
	return new ApiError(426, message);
}
export function onUpgrade(handler: (message: string) => void): () => void {
	upgrades.add(handler); if (upgrade) handler(upgrade);
	return () => { upgrades.delete(handler); };
}
function workspace(): WorkspaceState {
	return {
		release: RELEASE, name: "Workspace", cwd: "", directoryError, sessions: [...remotes.entries()].flatMap(([id, remote]) =>
			(remote.state?.sessions ?? []).map(session => ({ ...session, computer: id, key: sessionKey(id, session.key) }))),
		computers: [...remotes.entries()].map(([id, remote]) => ({
			id, name: remote.device.name, cwd: remote.state?.cwd ?? "", online: remote.client.connected,
			epoch: remote.epoch, error: remote.client.error, relay: remote.state?.relay,
			release: remote.state?.release, upgrade: remote.client.errorStatus === 426,
		})).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
	};
}
function emit(event: WorkspaceEvent, accepted?: () => void): void {
	if (!consumers.size) { accepted?.(); return; }
	for (const consume of consumers) consume(event, accepted);
}
function emitWorkspace(): void { emit({ type: "state", state: workspace() }); }
function reconcile(devices: WorkspaceDevice[]): void {
	for (const [id, remote] of remotes) {
		const value = devices.find(item => item.id === id);
		if (!value || value.thumbprint !== remote.device.thumbprint) {
			remote.unlisten(); remote.client.close(); remotes.delete(id);
		} else remote.device = value;
	}
	for (const computer of devices) {
		const id = computer.id;
		if (remotes.has(id)) continue;
		const client = new RemoteClient(account!, { id, thumbprint: computer.thumbprint });
		const remote: ComputerConnection = { device: computer, client, epoch: 0, unlisten: () => {} };
		remotes.set(id, remote);
		remote.unlisten = client.subscribe((event, sequence) => {
			const epoch = remote.epoch;
			const accepted = () => { if (remote.epoch === epoch) client.acknowledge(sequence); };
			if (event.type === "state") {
				remote.state = event.state;
				emit({ type: "state", state: workspace() }, accepted);
			} else if (event.type === "session") {
				if (remote.state) remote.state = { ...remote.state, sessions: [
					...remote.state.sessions.filter(item => item.key !== event.session.key), event.session,
				] };
				emit({ type: "session", session: { ...event.session, key: sessionKey(id, event.session.key), computer: id } }, accepted);
			} else emit({ ...event, key: sessionKey(id, event.key) }, accepted);
		}, online => {
			if (online) remote.epoch++;
			emitWorkspace();
		});
	}
	emitWorkspace();
}
export async function refreshDirectory(force = false): Promise<void> {
	if (!account) return;
	if (syncing) { if (!force) return syncing; await syncing.catch(() => {}); }
	if (!account) return;
	const current = account, epoch = generation;
	const job = (async () => {
		const result = await current.directory();
		if (current !== account || epoch !== generation) return;
		if (result.account !== workspaceIdentity(current.config) || !Array.isArray(result.devices) || result.devices.length > 1000) {
			throw new Error("Invalid account directory.");
		}
		const devices = await Promise.all(result.devices.filter(device => device.kind === "host" && device.revoked === undefined).map(async device => {
			identifier(device.id);
			if (typeof device.name !== "string" || device.name.length > 100 || (await deviceKey(device.key)).thumbprint !== device.thumbprint) {
				throw new Error("Invalid computer identity.");
			}
			return device;
		}));
		if (current !== account || epoch !== generation) return;
		directoryError = undefined; reconcile(devices);
	})().catch(error => {
		if (current === account && epoch === generation) { directoryError = "Account directory unavailable. Retrying."; emitWorkspace(); }
		throw error;
	}).finally(() => { if (syncing === job) syncing = undefined; });
	syncing = job; return job;
}
const syncDirectory = () => { if (mode === "account" && !document.hidden) void refreshDirectory().catch(() => {}); };
export async function renameComputer(id: string, name: string): Promise<void> {
	if (!account || !remotes.has(id)) throw new Error("Unknown computer.");
	await account.request(`/devices/${identifier(id)}/rename`, { name: name.trim() }); await refreshDirectory(true);
}
export async function removeComputer(id: string): Promise<void> {
	if (!account || !remotes.has(id)) throw new Error("Unknown computer.");
	await account.request(`/devices/${identifier(id)}/revoke`, {});
	const remote = remotes.get(id);
	remote?.unlisten(); remote?.client.close(); remotes.delete(id); emitWorkspace();
	await refreshDirectory(true);
}
export async function initialize(identity?: BrowserAccount): Promise<void> {
	dispose();
	const epoch = generation;
	account = identity; mode = identity ? "account" : "local";
	await surfaces.prepare();
	if (epoch !== generation) return;
	// Remove obsolete authorization data, not drafts, attachments or native conversations.
	for (const key of Object.keys(localStorage)) if (key.startsWith("pi-desk:computer:")) localStorage.removeItem(key);
	localStorage.removeItem("pi-desk:transport");
	if (mode === "account") {
		if (/^#(?:remote|pair)=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
		unwatchAccount = account!.watch(() => { if (!account?.signedIn()) dispose(); });
		await refreshDirectory();
		if (epoch !== generation) return;
		directoryTimer = setInterval(syncDirectory, 20_000);
		addEventListener("online", syncDirectory); document.addEventListener("visibilitychange", syncDirectory);
	} else {
		const token = new URLSearchParams(location.hash.slice(1)).get("pair");
		if (token) {
			history.replaceState(null, "", location.pathname + location.search);
			await api("/pair", { token, label: navigator.platform || "Browser" });
		}
		await api("/state");
	}
}
export function dispose(): void {
	generation++; clearInterval(directoryTimer); unwatchAccount?.(); unwatchAccount = undefined;
	removeEventListener("online", syncDirectory); document.removeEventListener("visibilitychange", syncDirectory);
	for (const remote of remotes.values()) { remote.unlisten(); remote.client.close(); }
	remotes.clear(); syncing = undefined; directoryError = undefined; upgrade = undefined; account = undefined; mode = undefined;
}
function convert(error: unknown): Error {
	return error instanceof RemoteError ? new ApiError(error.status, error.message) : error instanceof Error ? error : new Error(String(error));
}
function route(path: string, computer?: string): { remote: ComputerConnection; path: string; computer: string } {
	const match = /^\/sessions\/([a-f0-9-]{36}):([a-f0-9-]{36})(\/.*)?$/.exec(path);
	if (match) { computer = match[1]; path = `/sessions/${match[2]}${match[3] ?? ""}`; }
	if (!computer) throw new ApiError(400, "Choose a computer.");
	const remote = remotes.get(computer);
	if (!remote) throw new ApiError(403, "This computer is not in your account workspace.");
	return { remote, path, computer };
}
function body<T>(result: ApiResponse): T {
	if (result.status >= 400) throw new ApiError(result.status, (result.body as { error?: string }).error ?? "Request failed.");
	return result.body as T;
}
export async function api<T>(path: string, data?: unknown, computer?: string): Promise<T> {
	try {
		if (!mode) throw new ApiError(401, "Workspace access is not active.");
		if (mode === "account") {
			if (path === "/state" && data === undefined) return workspace() as T;
			const target = route(path, computer);
			const result = body<Record<string, unknown>>(await target.remote.client.request({
				path: `/api${target.path}`, method: data === undefined ? "GET" : "POST",
				...(data === undefined ? {} : { body: data as Record<string, unknown> }),
			}));
			if ((path === "/sessions" || path === "/resume") && typeof result.key === "string") {
				return { ...result, key: sessionKey(target.computer, result.key) } as T;
			}
			return result as T;
		}
		const response = await fetch(`/api${path}`, data === undefined ? { cache: "no-store", headers: { [API_HEADER]: String(API_VERSION) } } : {
			method: "POST", headers: { "Content-Type": "application/json", [API_HEADER]: String(API_VERSION) }, body: JSON.stringify(data),
		});
		const value = await response.json();
		if (response.status === 426) throw incompatible(value.error ?? "Update Pi Desk and reload the app.");
		if (!response.ok) throw new ApiError(response.status, value.error ?? "Request failed.");
		if (path === "/state" && !apiMatches(value.release?.api)) throw incompatible(upgradeMessage("This computer", value.release?.api));
		return value as T;
	} catch (error) { throw convert(error); }
}
async function assetBlob(session: string, asset: string, origin: string): Promise<Blob> {
	const path = `/sessions/${session}/assets/${asset}?${origin}`;
	if (mode === "local") {
		const response = await fetch(`/api${path}`, { cache: "no-store", headers: { [API_HEADER]: String(API_VERSION) } });
		if (response.status === 426) throw incompatible((await response.json()).error ?? "Update Pi Desk and reload the app.");
		if (!response.ok) throw new Error((await response.json()).error ?? "Asset unavailable.");
		return response.blob();
	}
	const target = route(path);
	const result = await target.remote.client.request({ path: `/api${target.path}`, method: "GET" });
	if (!result.asset) throw new Error((result.body as { error?: string }).error ?? "Asset unavailable.");
	return new Blob([decodeBase64(result.asset.base64)], { type: result.asset.mimeType });
}
const assetBlobs = new BlobPool();
export function acquireAsset(session: string, asset: string, origin: string): BlobLease {
	return assetBlobs.acquire(`${session}/${asset}?${origin}`, () => assetBlob(session, asset, origin));
}
export function subscribe(events: (batch: WorkspaceEvent[]) => void, connection: (connected: boolean) => void): () => void {
	if (!mode) { connection(false); return () => {}; }
	let timer: ReturnType<typeof setTimeout> | undefined, source: EventSource | undefined;
	let pending: WorkspaceEvent[] = [], weights: number[] = [], acknowledgements: (() => void)[] = [], size = 0;
	const clear = () => { clearTimeout(timer); timer = undefined; pending = []; weights = []; acknowledgements = []; size = 0; };
	const receive = (event: WorkspaceEvent, accepted?: () => void) => {
		const bytes = JSON.stringify(event).length * 2;
		if (event.type === "state" && pending.at(-1)?.type === "state") { size -= weights.pop()!; pending.pop(); }
		if (pending.length >= 128 || pending.length > 0 && size + bytes > 8 * 1024 * 1024) {
			clear();
			if (mode === "account") { for (const remote of remotes.values()) remote.client.reconnect(); }
			else { source?.close(); source = undefined; openLocal(); }
			return;
		}
		pending.push(event); weights.push(bytes); size += bytes;
		if (accepted) acknowledgements.push(accepted);
		if (!timer) timer = setTimeout(() => {
			const batch = pending, delivered = acknowledgements; clear();
			events(batch); for (const acknowledge of delivered) acknowledge();
		}, 50);
	};
	const relayReceive = (event: WorkspaceEvent, accepted?: () => void) => {
		receive(event, accepted);
		if (event.type === "state") connection(event.state.computers?.some(computer => computer.online) ?? false);
	};
	const openLocal = () => {
		if (document.hidden || source || upgrade) return;
		source = new EventSource(`/api/events?api=${API_VERSION}`);
		source.onmessage = message => {
			const event = JSON.parse(message.data) as HostEvent;
			if (event.type === "state" && !apiMatches(event.state.release?.api)) {
				incompatible(upgradeMessage("This computer", event.state.release?.api));
				source?.close(); source = undefined; connection(false); return;
			}
			receive(event);
		};
		source.onopen = () => connection(true);
		source.onerror = () => connection(false);
	};
	const visibility = () => {
		if (document.hidden) {
			clear(); source?.close(); source = undefined; connection(false);
			if (mode === "account") events([{ type: "state", state: workspace() }]);
		}
		else if (mode === "local") openLocal();
	};
	const hide = () => { clear(); source?.close(); source = undefined; connection(false); };
	if (mode === "account") { consumers.add(relayReceive); relayReceive({ type: "state", state: workspace() }); }
	else openLocal();
	document.addEventListener("visibilitychange", visibility);
	addEventListener("pagehide", hide); addEventListener("pageshow", visibility);
	return () => {
		consumers.delete(relayReceive); source?.close(); clear();
		document.removeEventListener("visibilitychange", visibility);
		removeEventListener("pagehide", hide); removeEventListener("pageshow", visibility);
	};
}
