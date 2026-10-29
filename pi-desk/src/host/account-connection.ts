import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import type { PartyComputer, PartyOperation, OperationResult } from "../../../pi-agents/network.ts";
import type { PartyOperations } from "../../../pi-agents/operations.ts";
import { accountConfiguration, accountOrigin, workspaceIdentity, type AccountConfiguration } from "../shared/account.ts";
import type { HostEvent } from "../shared/protocol.ts";
import type { ApiRequest, ApiResponse } from "../shared/relay-protocol.ts";
import { MAX_WIRE } from "../shared/secure-channel.ts";
import { readAccount, saveAccount, type SavedAccount } from "./account-config.ts";
import type { NativeAccountIdentity } from "./account-identity.ts";
import { AccountNetwork } from "./account-network.ts";
import type { DotConnector } from "./dot-connector.ts";
import type { HostCore } from "./host-core.ts";
import type { Parties } from "./parties.ts";
import { PartyNetwork } from "./party-network.ts";
import { RelayConnector, type RelayStatus, type RemoteAccess } from "./relay-connector.ts";
import type { SettingsSync } from "./settings-sync.ts";
import type { ConversationSearch } from "./conversation-search.ts";
import type { HostQuests } from "./host-quests.ts";
import type { Teleport } from "./teleport.ts";

/** How often a host checks the account service for a moved relay. */
const ACCOUNT_FOLLOW_MS = 10 * 60_000;

interface AccountHost {
	parties(): Parties;
	operations(): PartyOperations;
	settingsSync(): SettingsSync | undefined;
	teleport(): Teleport | undefined;
	search?(): ConversationSearch | undefined;
	quests?(): HostQuests | undefined;
	connector(): DotConnector | undefined;
	computer(): PartyComputer;
	execute(computer: string, request: PartyOperation): Promise<OperationResult["result"]>;
	/** An API request from a browser that reached this host through the relay or directly. */
	request(access: RemoteAccess, request: ApiRequest): Promise<ApiResponse>;
	/** Send host events to a remote browser, starting with the current state, until the returned function is called. */
	watch(handler: (event: HostEvent) => void): () => void;
}

/**
 * This computer's place in the workspace: its account identity, the relay connection that carries remote browsers,
 * agent messages and the Dot connector, the agent network to the other computers, and browsers on this computer that
 * connect directly. It follows the account service when the workspace's services move.
 */
export class AccountConnection {
	private readonly core: HostCore;
	private readonly host: AccountHost;
	private relayConnector?: RelayConnector;
	private relayStatus?: RelayStatus;
	private accountIdentity?: NativeAccountIdentity;
	private partyNetwork?: PartyNetwork;
	private revision = 0;
	private retry?: ReturnType<typeof setTimeout>;
	private following?: ReturnType<typeof setInterval>;
	private directSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_WIRE * 2, perMessageDeflate: false });
	constructor(core: HostCore, host: AccountHost) { this.core = core; this.host = host; }

	get relay(): RelayConnector | undefined { return this.relayConnector; }
	get status(): RelayStatus | undefined { return this.relayStatus; }
	get identity(): NativeAccountIdentity | undefined { return this.accountIdentity; }
	/** The agent network to the workspace's other computers, while the account connection is up. */
	get network(): PartyNetwork | undefined { return this.partyNetwork; }

	/** Connect with the saved account, then keep following its services. */
	async start(): Promise<void> {
		await this.connect();
		void this.follow();
		this.following = setInterval(() => { void this.follow(); }, ACCOUNT_FOLLOW_MS); this.following.unref();
	}

	close(): void {
		clearTimeout(this.retry); clearInterval(this.following); this.revision++;
		this.relayConnector?.close(); this.partyNetwork?.close();
		this.accountIdentity?.close();
	}

	/** This computer's public MCP address through the relay; undefined until the account connection is up. */
	connectorUrl(): string | undefined {
		return this.relayStatus && this.accountIdentity ? `${this.relayStatus.origin}/connector/${this.accountIdentity.device.id}` : undefined;
	}

	/**
	 * Hosts follow the workspace when its services move, as browsers do on each load. The website names the account
	 * service (desk-account.json) and the account service names the relay and website (/config); hosts saved both when
	 * they signed in, so they check here. The workspace itself never changes: device identities belong to it, and a
	 * moved account service keeps this computer's identity (`identityOrigin`).
	 */
	private async follow(): Promise<void> {
		if (this.core.closing) return;
		const network = new AccountNetwork(this.core.options.proxy);
		try {
			const saved = await readAccount(this.core.directory);
			if (!saved) return;
			let origin = saved.config.origin;
			const pointer = await network.request<{ accountOrigin?: unknown }>("GET", `${saved.appOrigin}/desk-account.json`, undefined, 10_000).catch(() => undefined);
			if (pointer?.status === 200 && typeof pointer.body.accountOrigin === "string") origin = accountOrigin(pointer.body.accountOrigin);
			const response = await network.request<AccountConfiguration>("GET", `${origin}/config`, undefined, 10_000);
			if (response.status !== 200 || this.core.closing) return;
			const config = accountConfiguration(response.body);
			if (config.origin !== origin || workspaceIdentity(config) !== workspaceIdentity(saved.config)) return;
			const moved = config.origin !== saved.config.origin;
			if (!moved && config.relayOrigin === saved.config.relayOrigin && config.appOrigins.join() === saved.config.appOrigins.join()) return;
			const identityOrigin = moved ? saved.identityOrigin ?? saved.config.origin : saved.identityOrigin;
			const next: SavedAccount = { version: 1, appOrigin: config.appOrigins.includes(saved.appOrigin) ? saved.appOrigin : config.appOrigins[0]!,
				config, ...(identityOrigin ? { identityOrigin } : {}) };
			await saveAccount(this.core.directory, next);
			console.error(moved ? `The workspace's account service moved to ${config.origin}; reconnecting.`
				: `The account service moved the relay or website; reconnecting.`);
			await this.connect();
		} catch { /* The saved configuration stays in use until the services answer. */ }
		finally { network.close(); }
	}

	/** (Re)connect with the saved account: its identity, the agent network and the relay. */
	async connect(): Promise<void> {
		const revision = ++this.revision;
		clearTimeout(this.retry); this.relayConnector?.close(); this.relayConnector = undefined;
		this.partyNetwork?.close(); this.partyNetwork = undefined;
		this.accountIdentity?.close(); this.accountIdentity = undefined; this.relayStatus = undefined;
		const saved = await readAccount(this.core.directory);
		if (this.core.closing || revision !== this.revision) return;
		if (!saved) { this.core.emit({ type: "state", state: this.core.state() }); return; }
		const update = (status: RelayStatus) => {
			if (this.core.closing || revision !== this.revision) return;
			this.relayStatus = status; this.core.emit({ type: "state", state: this.core.state() });
		};
		update({ origin: saved.config.relayOrigin, appOrigin: saved.appOrigin, state: "connecting" });
		try {
			const { NativeAccountIdentity } = await import("./account-identity.ts");
			const identity = await NativeAccountIdentity.open(this.core.directory, saved.config, { proxy: this.core.options.proxy, identityOrigin: saved.identityOrigin });
			if (this.core.closing || revision !== this.revision) { identity.close(); return; }
			this.accountIdentity = identity;
			const parties = this.host.parties();
			const network = new PartyNetwork(parties.store, workspaceIdentity(identity.config), () => {
				if (this.core.closing || revision !== this.revision) return;
				parties.networkChanged(); this.core.refreshParties();
			}, { operations: this.host.operations(), execute: (computer, request) => this.host.execute(computer, request) }, this.host.computer(),
				this.host.settingsSync(), this.host.teleport(), this.host.search?.(), this.host.quests?.());
			this.partyNetwork = network;
			this.relayConnector = new RelayConnector({ account: identity, appOrigin: saved.appOrigin, proxy: this.core.options.proxy, direct: Number(new URL(this.core.origin).port),
				request: (access, request) => this.host.request(access, request),
				watch: handler => this.host.watch(handler), status: update, party: {
					connected: (id, send, close) => network.connected(id, send, close),
					receive: (id, packet) => network.receive(id, packet),
				}, connector: { enabled: () => !!this.host.connector()?.enabled, handle: request => this.host.connector()!.handle(request, this.connectorUrl()!) },
			});
			this.relayConnector.start();
		} catch {
			if (this.core.closing || revision !== this.revision) return;
			this.relayConnector?.close(); this.relayConnector = undefined; this.partyNetwork?.close(); this.partyNetwork = undefined;
			this.accountIdentity?.close(); this.accountIdentity = undefined;
			update({ origin: saved.config.relayOrigin, appOrigin: saved.appOrigin, state: "offline",
				error: "Account identity is unavailable. Sign in on this computer and unlock its protected credential store." });
			this.retry = setTimeout(() => { void this.connect().catch(() => {}); }, 30_000);
			this.retry.unref();
		}
	}

	/**
	 * A browser on this computer connecting to the host directly rather than through the relay. Only this computer's
	 * Desk website may connect, for this computer; the relay connector then checks the browser as it would through the relay.
	 */
	upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
		const url = new URL(request.url ?? "/", this.core.origin), relay = this.relayConnector, appOrigin = this.relayStatus?.appOrigin;
		if (url.pathname !== "/direct" || !relay || !appOrigin || request.headers.origin !== appOrigin
			|| request.headers.host !== new URL(this.core.origin).host || url.searchParams.get("host") !== this.accountIdentity?.device.id) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
		}
		this.directSockets.handleUpgrade(request, socket, head, ws => relay === this.relayConnector ? relay.direct(ws) : ws.close(1013));
	}
}
