import type { HostEvent, HostState } from "../shared/protocol.ts";
import type { RemoteInvitation, ApiResponse } from "../shared/relay-protocol.ts";
import { remoteOrigins } from "../shared/relay-protocol.ts";
import { newSecret, unbase64, validId, validSecret } from "../shared/secure-channel.ts";
import { RemoteClient, RemoteError } from "./remote.ts";
import { COMPUTER_PREFIX, readComputers, saveComputer, forgetComputer, type SavedComputer } from "./computer-store.ts";
import { sessionKey, type WorkspaceEvent, type WorkspaceState } from "./workspace.ts";
import { surfaces } from "./surfaces.tsx";
import { BlobPool, decodeBase64, type BlobLease } from "./blob-pool.ts";
import { API_HEADER, API_VERSION, RELEASE, apiMatches, upgradeMessage } from "../shared/release.ts";

export class ApiError extends Error {
	status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}
interface ComputerConnection { saved: SavedComputer; client: RemoteClient; state?: HostState; epoch: number; unlisten: () => void }
const remotes = new Map<string, ComputerConnection>();
let mode: "local" | "relay" | undefined;
let relay: string;
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
		release: RELEASE, name: "Workspace", cwd: "", sessions: [...remotes.entries()].flatMap(([id, remote]) =>
			(remote.state?.sessions ?? []).map(session => ({ ...session, computer: id, key: sessionKey(id, session.key) }))),
		computers: [...remotes.entries()].map(([id, remote]) => ({
			id, name: remote.saved.alias || remote.saved.name, cwd: remote.state?.cwd ?? "", online: remote.client.connected,
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
function restoreComputers(): void {
	const saved = readComputers();
	for (const [id, remote] of remotes) {
		const value = saved.find(item => item.credential.host === id);
		if (!value || value.credential.device !== remote.saved.credential.device || value.credential.key !== remote.saved.credential.key) {
			remote.unlisten(); remote.client.close(); remotes.delete(id);
		} else remote.saved = value;
	}
	for (const computer of saved) {
		const id = computer.credential.host;
		if (remotes.has(id)) continue;
		const client = new RemoteClient(relay, { ...computer.credential }, credential => {
			const current = readComputers().find(item => item.credential.host === id);
			if (current?.credential.device === credential.device && current.credential.key === credential.key) {
				saveComputer({ ...current, credential });
			}
		});
		const remote: ComputerConnection = { saved: computer, client, epoch: 0, unlisten: () => {} };
		remotes.set(id, remote);
		remote.unlisten = client.subscribe((event, sequence) => {
			const epoch = remote.epoch;
			const accepted = () => { if (remote.epoch === epoch) client.acknowledge(sequence); };
			if (event.type === "state") {
				remote.state = event.state;
				const current = readComputers().find(item => item.credential.host === id);
				if (current && current.name !== event.state.name) {
					remote.saved = { ...current, name: event.state.name }; saveComputer(remote.saved);
				}
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
addEventListener("storage", event => { if (mode === "relay" && (!event.key || event.key.startsWith(COMPUTER_PREFIX))) restoreComputers(); });
addEventListener("hashchange", () => { if (/^#(?:remote|pair)=/.test(location.hash)) location.reload(); });
export function renameComputer(id: string, name: string): void {
	const value = readComputers().find(item => item.credential.host === id);
	if (value) { saveComputer({ ...value, alias: name.trim().slice(0, 100) || undefined }); restoreComputers(); }
}
export function removeComputer(id: string): void { forgetComputer(id); restoreComputers(); }
async function discover(): Promise<void> {
	let transport;
	try {
		const response = await fetch("/desk-transport.json", { cache: "no-store", signal: AbortSignal.timeout(5000) });
		if (!response.ok) throw new Error(`Pi Desk server is unavailable (HTTP ${response.status}).`);
		transport = await response.json();
	} catch (error) {
		const saved = localStorage.getItem("pi-desk:transport");
		try { if (saved) transport = JSON.parse(saved); } catch { /* No usable offline configuration. */ }
		if (!transport) throw error;
	}
	if (!transport || (transport.kind !== "relay" && transport.kind !== "local")) throw incompatible("This server is not running a matching Pi Desk API.");
	if (!apiMatches(transport.api)) throw incompatible(upgradeMessage("This server", transport.api));
	if (transport.kind === "relay") {
		try {
			const origins = remoteOrigins(transport.relay, transport.appOrigin);
			if (origins.appOrigin !== location.origin) throw new Error();
			relay = origins.origin;
		} catch { throw incompatible("The app's deployment configuration must name this app origin and its separate relay."); }
	}
	mode = transport.kind;
	localStorage.setItem("pi-desk:transport", JSON.stringify(transport));
}
export async function initialize(): Promise<void> {
	const hash = location.hash;
	if (hash) history.replaceState(null, "");
	await surfaces.prepare();
	await discover();
	if (hash) {
		await pair(`${location.origin}/${hash}`);
		history.replaceState(null, "", location.pathname + location.search);
	}
	if (mode === "relay") {
		restoreComputers();
		if (!remotes.size) throw new ApiError(401, "Open an invitation from a computer to pair this browser.");
	}
}
export async function pair(invitation: string): Promise<void> {
	if (!mode) await discover();
	let params: URLSearchParams;
	if (invitation.trim().startsWith("http")) {
		const url = new URL(invitation.trim());
		if (url.origin !== location.origin) throw new ApiError(400, "Open this invitation at its original address.");
		params = new URLSearchParams(url.hash.slice(1));
	} else params = new URLSearchParams({ pair: invitation.trim() });
	if (mode === "relay") {
		const value = params.get("remote");
		if (!value || value.length > 2000) throw new ApiError(400, "Use a remote pairing invitation from your computer.");
		const data = JSON.parse(new TextDecoder().decode(unbase64(value))) as RemoteInvitation;
		if (!validId(data.host) || !validId(data.device) || !validSecret(data.key)) throw new ApiError(400, "Invalid invitation.");
		const saved = readComputers(), existing = saved.find(item => item.credential.host === data.host);
		if (!existing && saved.length >= 16) throw new ApiError(400, "This browser has 16 computers. Forget one before adding another.");
		const credential = existing?.credential.device === data.device ? existing.credential :
			{ host: data.host, device: data.device, key: newSecret(), invitation: data.key, label: navigator.platform || "Browser" };
		// The claim may reach the host without its acknowledgement reaching this browser.
		saveComputer({ ...existing, name: existing?.name ?? `Computer ${data.host.slice(0, 8)}`, credential });
		restoreComputers();
	} else await api("/pair", { token: params.get("pair") ?? "", label: navigator.platform || "Browser" });
}
function convert(error: unknown): Error {
	return error instanceof RemoteError ? new ApiError(error.status, error.message) : error instanceof Error ? error : new Error(String(error));
}
function route(path: string, computer?: string): { remote: ComputerConnection; path: string; computer: string } {
	const match = /^\/sessions\/([a-f0-9-]{36}):([a-f0-9-]{36})(\/.*)?$/.exec(path);
	if (match) { computer = match[1]; path = `/sessions/${match[2]}${match[3] ?? ""}`; }
	if (!computer) throw new ApiError(400, "Choose a computer.");
	const remote = remotes.get(computer);
	if (!remote) throw new ApiError(401, "This computer is not paired in this browser.");
	return { remote, path, computer };
}
function body<T>(result: ApiResponse): T {
	if (result.status >= 400) throw new ApiError(result.status, (result.body as { error?: string }).error ?? "Request failed.");
	return result.body as T;
}
export async function api<T>(path: string, data?: unknown, computer?: string): Promise<T> {
	try {
		if (mode === "relay") {
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
	let timer: ReturnType<typeof setTimeout> | undefined, source: EventSource | undefined;
	let pending: WorkspaceEvent[] = [], weights: number[] = [], acknowledgements: (() => void)[] = [], size = 0;
	const clear = () => { clearTimeout(timer); timer = undefined; pending = []; weights = []; acknowledgements = []; size = 0; };
	const receive = (event: WorkspaceEvent, accepted?: () => void) => {
		const bytes = JSON.stringify(event).length * 2;
		if (event.type === "state" && pending.at(-1)?.type === "state") { size -= weights.pop()!; pending.pop(); }
		if (pending.length >= 128 || pending.length > 0 && size + bytes > 8 * 1024 * 1024) {
			clear();
			if (mode === "relay") { for (const remote of remotes.values()) remote.client.reconnect(); }
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
			if (mode === "relay") events([{ type: "state", state: workspace() }]);
		}
		else if (mode === "local") openLocal();
	};
	const hide = () => { clear(); source?.close(); source = undefined; connection(false); };
	if (mode === "relay") { consumers.add(relayReceive); relayReceive({ type: "state", state: workspace() }); }
	else openLocal();
	document.addEventListener("visibilitychange", visibility);
	addEventListener("pagehide", hide); addEventListener("pageshow", visibility);
	return () => {
		consumers.delete(relayReceive); source?.close(); clear();
		document.removeEventListener("visibilitychange", visibility);
		removeEventListener("pagehide", hide); removeEventListener("pageshow", visibility);
	};
}
