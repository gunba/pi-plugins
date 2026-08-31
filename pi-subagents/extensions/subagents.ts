import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type {
	ApiKeyAuth,
	AuthResult,
	ModelAuth,
	Provider,
} from "@earendil-works/pi-ai";
import { PiSdkDriverFactory } from "./pi-sdk-driver.ts";
import {
	activitySummary,
	SubagentDashboard,
	type DashboardAction,
	type DashboardSnapshot,
} from "./subagent-dashboard.ts";
import {
	LAUNCH_ENTRY,
	SubagentRuntime,
	type ModelRef,
	type ParentNotice,
	type RuntimeHost,
} from "./subagent-runtime.ts";
import { createSubagentToolDefinitions } from "./subagent-tools.ts";
import { readSessionTranscript } from "./session-transcript.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activeLaunchIds(ctx: ExtensionContext): Set<string> {
	const parentSessionId = ctx.sessionManager.getSessionId();
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry.type !== "custom" ||
			entry.customType !== LAUNCH_ENTRY ||
			!isRecord(entry.data)
		)
			continue;
		if (
			entry.data.parentSessionId === parentSessionId &&
			typeof entry.data.childId === "string"
		)
			ids.add(entry.data.childId);
	}
	return ids;
}

function noticeLabel(notice: ParentNotice): string {
	return `${notice.kind} · ${notice.childId.slice(0, 8)}`;
}

export type CachedProviderAuth = {
	apiKey?: string;
	headers: Record<string, string | null>;
};

const AUTH_HEADER_NAMES = new Set([
	"authorization",
	"api-key",
	"x-api-key",
	"x-goog-api-key",
	"cf-aig-authorization",
	"chatgpt-account-id",
]);

/** Keep only request authentication material, in memory, for immediate child inheritance. */
export function captureProviderAuth(
	headers: Record<string, string | null>,
	apiKey?: string,
): CachedProviderAuth | undefined {
	const captured: Record<string, string | null> = {};
	let capturedApiKey = apiKey;
	for (const [name, value] of Object.entries(headers)) {
		const normalized = name.toLowerCase();
		if (!AUTH_HEADER_NAMES.has(normalized) || value === null) continue;
		captured[normalized] = value;
		if (!capturedApiKey && normalized === "authorization") {
			const match = /^Bearer\s+(.+)$/i.exec(value.trim());
			if (match?.[1]) capturedApiKey = match[1];
		}
	}
	if (!capturedApiKey && Object.keys(captured).length === 0) return undefined;
	return {
		...(capturedApiKey ? { apiKey: capturedApiKey } : {}),
		headers: captured,
	};
}

function providerWithRequestAuth(
	provider: Provider,
	requestAuth: ModelAuth,
	env: AuthResult["env"],
): Provider {
	const original = provider.auth.apiKey;
	const apiKey: ApiKeyAuth = {
		name: original?.name ?? `${provider.name} parent-session authentication`,
		...(original?.login ? { login: original.login.bind(original) } : {}),
		async check(input) {
			const resolved = await original?.check?.(input);
			return resolved ?? { type: "api_key", source: "parent session" };
		},
		async resolve(input) {
			const resolved = await original?.resolve(input);
			return (
				resolved ?? {
					auth: requestAuth,
					...(env && Object.keys(env).length > 0 ? { env } : {}),
					source: "parent session",
				}
			);
		},
	};
	return {
		id: provider.id,
		name: provider.name,
		baseUrl: provider.baseUrl,
		headers: provider.headers,
		auth: { ...provider.auth, apiKey },
		getModels: () => provider.getModels(),
		...(provider.refreshModels
			? { refreshModels: provider.refreshModels.bind(provider) }
			: {}),
		...(provider.filterModels
			? { filterModels: provider.filterModels.bind(provider) }
			: {}),
		stream: provider.stream.bind(provider),
		streamSimple: provider.streamSimple.bind(provider),
		...(provider.fetchDeferred
			? { fetchDeferred: provider.fetchDeferred.bind(provider) }
			: {}),
		...(provider.cancelDeferred
			? { cancelDeferred: provider.cancelDeferred.bind(provider) }
			: {}),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function inheritProviderRuntime(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	ref: ModelRef,
	modelRuntime: ModelRuntime,
	fallback?: CachedProviderAuth,
): Promise<void> {
	const model = ctx.modelRegistry.find(ref.provider, ref.id);
	const provider = ctx.modelRegistry.getProvider(ref.provider);
	if (!model || !provider)
		throw new Error(`cannot resolve parent provider ${ref.provider}/${ref.id}`);

	// Register the effective parent provider, but let the fresh child runtime
	// resolve its own stored credential first. In particular, an OAuth access
	// token is not an API-key credential: converting it with setRuntimeApiKey()
	// makes OAuth-only providers such as openai-codex unresolvable.
	modelRuntime.registerNativeProvider(provider);
	const childModel = modelRuntime.getModel(ref.provider, ref.id);
	if (!childModel)
		throw new Error(`cannot restore child model ${ref.provider}/${ref.id}`);
	let childAuthError: string | undefined;
	try {
		if (await modelRuntime.getAuth(childModel)) return;
	} catch (error) {
		childAuthError = errorMessage(error);
	}

	const modelAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	let providerAuth: Awaited<ReturnType<typeof ctx.modelRegistry.getProviderAuth>>;
	let providerAuthError: string | undefined;
	try {
		providerAuth = await ctx.modelRegistry.getProviderAuth(ref.provider);
	} catch (error) {
		providerAuthError = errorMessage(error);
	}
	const apiKey =
		providerAuth?.auth.apiKey ??
		(modelAuth.ok ? modelAuth.apiKey : undefined) ??
		fallback?.apiKey;
	const headers = {
		...provider.headers,
		...providerAuth?.auth.headers,
		...(modelAuth.ok ? modelAuth.headers : undefined),
		...fallback?.headers,
	};
	const env = {
		...providerAuth?.env,
		...(modelAuth.ok ? modelAuth.env : undefined),
	};
	const baseUrl =
		providerAuth?.auth.baseUrl ??
		(modelAuth.ok ? modelAuth.baseUrl : undefined) ??
		provider.baseUrl;
	const requestAuth: ModelAuth = {
		...(apiKey ? { apiKey } : {}),
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		...(baseUrl ? { baseUrl } : {}),
	};
	if (!apiKey) {
		const reason =
			childAuthError ??
			providerAuthError ??
			(modelAuth.ok
				? `no request credential is available for ${ref.provider}`
				: modelAuth.error);
		throw new Error(`cannot inherit authentication for ${ref.provider}: ${reason}`);
	}

	// A parent may hold a runtime-only credential or a still-valid request token
	// while the shared store cannot currently resolve. Add an in-memory API-key
	// fallback only for that exceptional path, then make the credential type
	// match the fallback resolver.
	modelRuntime.registerNativeProvider(
		providerWithRequestAuth(provider, requestAuth, env),
	);
	await modelRuntime.setRuntimeApiKey(ref.provider, apiKey);
	const inheritedModel = modelRuntime.getModel(ref.provider, ref.id);
	if (!inheritedModel || !(await modelRuntime.getAuth(inheritedModel)))
		throw new Error(`cannot inherit authentication for ${ref.provider}`);
}

export function rootNoticeDelivery(
	notice: Pick<ParentNotice, "kind">,
	isIdle: boolean,
): "steer" | "followUp" {
	return notice.kind === "settlement" && !isIdle ? "steer" : "followUp";
}

function deliveredRootNoticeIds(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry.type === "custom_message" &&
			entry.customType === "pi-subagents/notice" &&
			isRecord(entry.details) &&
			typeof entry.details.messageId === "string"
		) ids.add(entry.details.messageId);
	}
	return ids;
}

/** DSH-style subagents for Pi 0.84.3. */
export default function subagents(pi: ExtensionAPI): void {
	let runtime: SubagentRuntime | undefined;
	let currentContext: ExtensionContext | undefined;
	let unsubscribeRuntime: (() => void) | undefined;
	let toolsRegistered = false;
	const feed: string[] = [];
	const providerAuth = new Map<string, CachedProviderAuth>();

	const requireRuntime = (): SubagentRuntime => {
		if (!runtime) throw new Error("subagent runtime is not initialized");
		return runtime;
	};

	const updateActivity = (ctx: ExtensionContext): void => {
		if (!runtime) return;
		const agents = runtime.snapshot();
		if (agents.length === 0) {
			ctx.ui.setWidget("pi-subagents", undefined);
			ctx.ui.setStatus("pi-subagents", undefined);
			return;
		}
		const summary = activitySummary(agents);
		ctx.ui.setWidget("pi-subagents", [summary]);
		ctx.ui.setStatus("pi-subagents", summary.replace(/  —.*/, ""));
	};

	const dashboardSnapshot = (selectedId?: string): DashboardSnapshot => {
		const active = requireRuntime();
		const transcript = readSessionTranscript(
			selectedId ? active.getSessionFile(selectedId) : undefined,
		);
		return {
			rootSessionId: active.host.rootSessionId,
			agents: active.snapshot(),
			feed: feed.slice(-8),
			transcript: transcript.lines,
			...(transcript.error ? { transcriptError: transcript.error } : {}),
		};
	};

	const stopRuntime = async (): Promise<void> => {
		unsubscribeRuntime?.();
		unsubscribeRuntime = undefined;
		await runtime?.shutdown();
		runtime = undefined;
	};

	const startRuntime = async (ctx: ExtensionContext): Promise<void> => {
		await stopRuntime();
		currentContext = ctx;
		const launches = activeLaunchIds(ctx);
		const rootNotices = deliveredRootNoticeIds(ctx);
		const queuedRootNotices = new Set<string>();
		const host: RuntimeHost = {
			rootSessionId: ctx.sessionManager.getSessionId(),
			rootSessionFile: ctx.sessionManager.getSessionFile(),
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			activeRootLaunchIds: launches,
			recordRootLaunch(childId: string) {
				launches.add(childId);
				pi.appendEntry(LAUNCH_ENTRY, {
					parentSessionId: ctx.sessionManager.getSessionId(),
					childId,
					createdAt: Date.now(),
				});
			},
			deliverRootNotice(notice: ParentNotice) {
				if (rootNotices.has(notice.messageId)) return true;
				if (queuedRootNotices.has(notice.messageId)) return false;
				feed.push(`${new Date().toISOString()} ${noticeLabel(notice)}`);
				pi.sendMessage(
					{
						customType: "pi-subagents/notice",
						content: notice.content,
						display: true,
						details: notice,
					},
					{
						deliverAs: rootNoticeDelivery(notice, ctx.isIdle()),
						triggerTurn: true,
					},
				);
				queuedRootNotices.add(notice.messageId);
				updateActivity(ctx);
				return false;
			},
			resolveModel(ref: ModelRef) {
				return ctx.modelRegistry.find(ref.provider, ref.id);
			},
			async prepareModelRuntime(ref, modelRuntime) {
				await inheritProviderRuntime(
					ctx,
					ref,
					modelRuntime,
					providerAuth.get(ref.provider),
				);
			},
		};
		let created!: SubagentRuntime;
		const driverFactory = new PiSdkDriverFactory(host);
		created = new SubagentRuntime(
			host,
			driverFactory,
			(childRuntime, authority, mode) =>
				createSubagentToolDefinitions(
					childRuntime,
					{
						getAuthority: () => authority,
						getToolNames: () => childRuntime.toolNamesFor(authority),
					},
					mode,
				),
		);
		runtime = created;
		unsubscribeRuntime = created.subscribe(() => updateActivity(ctx));
		created.initialize();

		if (!toolsRegistered) {
			for (const tool of createSubagentToolDefinitions(
				requireRuntime,
				{
					getAuthority: () => requireRuntime().rootAuthority,
					getToolNames: () => pi.getActiveTools(),
				},
				"root",
			))
				pi.registerTool(tool);
			toolsRegistered = true;
		}
		updateActivity(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		feed.length = 0;
		providerAuth.clear();
		await startRuntime(ctx);
	});

	pi.on("before_provider_headers", async (event, ctx) => {
		if (!ctx.model) return;
		let resolved: Awaited<ReturnType<typeof ctx.modelRegistry.getProviderAuth>>;
		try {
			resolved = await ctx.modelRegistry.getProviderAuth(ctx.model.provider);
		} catch {
			// The request itself already resolved. Header-only capture remains useful
			// for providers that place their complete credential in request headers.
		}
		const captured = captureProviderAuth(
			{ ...resolved?.auth.headers, ...event.headers },
			resolved?.auth.apiKey,
		);
		if (captured) providerAuth.set(ctx.model.provider, captured);
	});

	pi.on("session_before_tree", (_event, ctx) => {
		if (runtime?.hasLiveDescendants(runtime.rootAuthority)) {
			ctx.ui.notify(
				"Settle or interrupt running subagents before changing this session branch.",
				"warning",
			);
			return { cancel: true };
		}
		return undefined;
	});

	pi.on("session_tree", async (_event, ctx) => {
		feed.length = 0;
		await startRuntime(ctx);
	});

	pi.on("message_end", (event) => {
		if (
			event.message.role !== "custom" ||
			event.message.customType !== "pi-subagents/notice" ||
			!isRecord(event.message.details) ||
			typeof event.message.details.messageId !== "string"
		) return;
		runtime?.acknowledgeRootNotice(event.message.details.messageId);
	});

	pi.on("session_shutdown", async () => {
		if (currentContext) {
			currentContext.ui.setWidget("pi-subagents", undefined);
			currentContext.ui.setStatus("pi-subagents", undefined);
		}
		await stopRuntime();
		currentContext = undefined;
	});

	pi.registerCommand("subagents", {
		description: "Inspect and control durable background subagents",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The subagent dashboard requires TUI mode.", "warning");
				return;
			}
			let selectedId = args.trim() || undefined;
			while (runtime) {
				let dashboard: SubagentDashboard | undefined;
				let unsubscribe: (() => void) | undefined;
				const action = await ctx.ui.custom<DashboardAction | null>((tui, theme, _keybindings, done) => {
					dashboard = new SubagentDashboard(
						dashboardSnapshot(selectedId),
						selectedId,
						theme,
						() => tui.requestRender(),
						done,
						() => Math.max(8, tui.terminal.rows - 2),
						(id) => {
							if (!dashboard) return;
							dashboard.update(dashboardSnapshot(id));
							tui.requestRender();
						},
					);
					unsubscribe = requireRuntime().subscribe(() => {
						if (!dashboard) return;
						dashboard.update(
							dashboardSnapshot(dashboard.getSelectedId()),
						);
						tui.requestRender();
					});
					return dashboard;
				});
				unsubscribe?.();
				selectedId = dashboard?.getSelectedId();
				if (!action) return;
				if (action.action === "message") {
					const message = await ctx.ui.editor(
						`Message ${action.id.slice(0, 8)}`,
						"",
					);
					if (message?.trim()) {
						const messageId = requireRuntime().sendMessage(
							requireRuntime().rootAuthority,
							action.id,
							message,
						);
						feed.push(
							`${new Date().toISOString()} message ${messageId.slice(0, 8)} → ${action.id.slice(0, 8)}`,
						);
					}
				} else {
					requireRuntime().interrupt(
						requireRuntime().rootAuthority,
						action.id,
					);
					feed.push(
						`${new Date().toISOString()} interrupt → ${action.id.slice(0, 8)}`,
					);
				}
			}
		},
	});
}
