import {
	Client,
	Pool,
	EnvHttpProxyAgent,
	getGlobalDispatcher,
	setGlobalDispatcher,
	install,
	type Dispatcher,
	type Agent,
} from "undici";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { EventEmitter } from "node:events";

/** SDK hosts own HTTP setup. Keep request deadlines and proxy routing from Pi settings. */
export class WorkspaceHttp {
	private previous = getGlobalDispatcher();
	private dispatcher?: EnvHttpProxyAgent;
	private timeout?: number;
	private proxy?: string;
	private retired: Promise<void>[] = [];
	private closeErrors: unknown[] = [];
	private originalFetch = globalThis.fetch;
	private installedFetch?: typeof fetch;
	private proxyEnvironment = new Map<string, string>();
	private globals = new Map<
		string,
		{ previous: PropertyDescriptor | undefined; installed: unknown }
	>();
	configure(settings: SettingsManager): void {
		const timeout = settings.getHttpIdleTimeoutMs();
		const project = settings.isProjectTrusted() ? settings.getProjectSettings() : {};
		const proxy = project.httpProxy ?? settings.getGlobalSettings().httpProxy;
		if (this.dispatcher && timeout === this.timeout && proxy === this.proxy) return;
		if (!Number.isFinite(timeout) || timeout < 0)
			throw Error("Invalid HTTP idle timeout in Pi settings.");
		for (const [key, value] of this.proxyEnvironment)
			if (process.env[key] === value) delete process.env[key];
		this.proxyEnvironment.clear();
		if (proxy)
			for (const key of ["HTTP_PROXY", "HTTPS_PROXY"]) {
				if (process.env[key] === undefined) {
					process.env[key] = proxy;
					this.proxyEnvironment.set(key, proxy);
				}
			}
		const observe = <T extends Dispatcher>(dispatcher: T): T => {
			// Request errors still reject fetch/read. A dispatcher error event must not
			// escape as an uncaught EventEmitter error during cancellation.
			(dispatcher as unknown as EventEmitter).on("error", () => {});
			return dispatcher;
		};
		const clientFactory = (origin: string | URL, options: Client.Options) =>
			observe(new Client(origin, options));
		const factory: Agent.Options["factory"] = (origin, options) =>
			(options as Pool.Options).connections === 1
				? clientFactory(origin, options)
				: observe(new Pool(origin, { ...options, factory: clientFactory }));
		const dispatcher = observe(
			new EnvHttpProxyAgent({
				allowH2: false,
				proxyTunnel: true,
				bodyTimeout: timeout,
				headersTimeout: timeout,
				connect: { autoSelectFamilyAttemptTimeout: 2000 },
				clientFactory,
				factory,
				...(proxy
					? {
							httpProxy: process.env.HTTP_PROXY ?? process.env.http_proxy ?? proxy,
							httpsProxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? proxy,
						}
					: {}),
			}),
		);
		if (this.dispatcher)
			this.retired.push(
				this.dispatcher.close().catch((error) => {
					this.closeErrors.push(error);
				}),
			);
		this.dispatcher = dispatcher;
		this.timeout = timeout;
		this.proxy = proxy;
		setGlobalDispatcher(dispatcher);
		if (globalThis.fetch === (this.installedFetch ?? this.originalFetch)) {
			const target = globalThis as unknown as Record<string, unknown>;
			const keys = [
				"fetch",
				"Headers",
				"Response",
				"Request",
				"FormData",
				"WebSocket",
				"CloseEvent",
				"ErrorEvent",
				"MessageEvent",
				"EventSource",
			];
			for (const key of keys)
				if (!this.globals.has(key))
					this.globals.set(key, {
						previous: Object.getOwnPropertyDescriptor(globalThis, key),
						installed: undefined,
					});
			install();
			this.installedFetch = globalThis.fetch;
			for (const key of keys) this.globals.get(key)!.installed = target[key];
		}
	}
	async dispose(): Promise<void> {
		if (getGlobalDispatcher() === this.dispatcher) setGlobalDispatcher(this.previous);
		await Promise.all([
			...this.retired,
			...(this.dispatcher
				? [
						this.dispatcher.close().catch((error) => {
							this.closeErrors.push(error);
						}),
					]
				: []),
		]);
		this.dispatcher = undefined;
		for (const [key, value] of this.proxyEnvironment)
			if (process.env[key] === value) delete process.env[key];
		this.proxyEnvironment.clear();
		const target = globalThis as unknown as Record<string, unknown>;
		for (const [key, state] of this.globals)
			if (target[key] === state.installed) {
				if (state.previous) Object.defineProperty(globalThis, key, state.previous);
				else delete target[key];
			}
		this.globals.clear();
		this.retired = [];
		if (this.closeErrors.length) {
			const errors = this.closeErrors.splice(0);
			throw new AggregateError(errors, "HTTP dispatcher shutdown failed.");
		}
	}
}
