import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionFactory, InlineExtension, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { createIsolatedJiti } from "../loader/isolated-jiti.ts";

export interface LoadChildToolExtensionsOptions {
	tools: ToolInfo[];
	handledToolNames: Iterable<string>;
	signal: AbortSignal;
	projectTrusted: boolean;
	/** Parent-authoritative configuration, not parent tool execution. */
	getFlag?: (name: string) => boolean | string | undefined;
}

// Resolve public framework entries from the SDK, not the provider's node_modules.
// The SDK may have nested dependencies, so importing a same-named peer from this
// package can create a second framework identity. Only native framework modules
// are cached here; no extension/provider modules enter this graph.
let frameworkModules: Promise<Record<string, unknown>> | undefined;
function getFrameworkModules(): Promise<Record<string, unknown>> {
	return frameworkModules ??= (async () => {
		const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
		const resolver = createJiti(sdkEntry);
		const specifiers = ["typebox", "typebox/compile", "typebox/value",
			"@earendil-works/pi-agent-core", "@earendil-works/pi-ai/compat",
			"@earendil-works/pi-ai/oauth", "@earendil-works/pi-ai/providers/all", "@earendil-works/pi-tui"];
		const modules: Record<string, unknown> = { "@earendil-works/pi-coding-agent": await import(sdkEntry) };
		await Promise.all(specifiers.map(async (name) => {
			modules[name] = await import(resolver.esmResolve(name));
		}));
		// Match Pi's compat routing and legacy virtual module aliases.
		modules["@earendil-works/pi-ai"] = modules["@earendil-works/pi-ai/compat"];
		for (const [name, module] of Object.entries(modules)) {
			if (name.startsWith("@earendil-works/")) modules[name.replace("@earendil-works/", "@mariozechner/")] = module;
			else if (name.startsWith("typebox")) modules[`@sinclair/${name}`] = module;
		}
		return modules;
	})();
}

interface ProviderSource {
	path: string;
	names: Set<string>;
}

function sourceError(names: Iterable<string>, reason: string, cause?: unknown): Error {
	return new Error(`Cannot inherit child tool provider for ${[...names].map((name) => JSON.stringify(name)).join(", ")}: ${reason}`,
		cause === undefined ? undefined : { cause });
}

/**
 * Reconstruct parent-authorized providers without retaining parent executions.
 *
 * Only metadata/filesystem validation happens here. One named factory loads all
 * providers into one private graph when the CHILD loader invokes it. Reinvoking
 * it on reload or in another child creates another graph; dependencies shared
 * by different provider entrypoints retain identity within that activation.
 * Its complete lifecycle/policy registrations use that child's ExtensionAPI.
 * Unowned/overridden tool registrations are discarded, also when registered later
 * by hooks; other API behavior is unchanged. The driver still owns active-tool
 * selection, post-session_start availability checks and failed-session cleanup.
 *
 * This is module-state isolation, not a sandbox: trusted extension code can use
 * native process APIs. Abort is checked at asynchronous boundaries; arbitrary JS
 * module evaluation/factory code cannot be forcibly interrupted in-process.
 */
export async function loadChildToolExtensions({
	tools, handledToolNames, signal, projectTrusted, getFlag,
}: LoadChildToolExtensionsOptions): Promise<InlineExtension[]> {
	signal.throwIfAborted();
	const handled = new Set(handledToolNames);
	const providers = new Map<string, ProviderSource>();
	const owners = new Map<string, string>();

	// Validate the complete metadata set before evaluating any provider code.
	for (const tool of tools) {
		signal.throwIfAborted();
		if (handled.has(tool.name) || tool.sourceInfo?.source === "builtin") continue;
		const source = tool.sourceInfo;
		if (!source) throw sourceError([tool.name], "parent tool metadata has no sourceInfo.");
		if (source.scope === "project" && !projectTrusted) {
			throw sourceError([tool.name], `project trust is required for ${JSON.stringify(source.path)}.`);
		}
		if (!source.path || !isAbsolute(source.path)) {
			throw sourceError([tool.name], `source ${JSON.stringify(source.path ?? source.source)} is synthetic, inline or not an absolute file path; provide a real extension source file or a child-scoped handled tool.`);
		}
		let path: string;
		try {
			path = await realpath(source.path);
			if (!(await stat(path)).isFile()) throw new Error("source is not a file");
		} catch (error) {
			signal.throwIfAborted();
			throw sourceError([tool.name], `cannot read extension source ${JSON.stringify(source.path)} (${error instanceof Error ? error.message : String(error)}).`, error);
		}
		signal.throwIfAborted();
		const key = process.platform === "win32" ? path.toLowerCase() : path;
		const prior = owners.get(tool.name);
		if (prior && prior !== key) throw sourceError([tool.name], "parent metadata assigns this tool to multiple source files.");
		owners.set(tool.name, key);
		let provider = providers.get(key);
		if (!provider) {
			provider = { path, names: new Set() };
			providers.set(key, provider);
		}
		provider.names.add(tool.name);
	}

	if (!providers.size) return [];
	return [{ name: "inherited-tool-providers", factory: async (pi) => {
		signal.throwIfAborted();
		const virtualModules = await getFrameworkModules();
		signal.throwIfAborted();
		const jiti = await createIsolatedJiti(import.meta.url, virtualModules);
		signal.throwIfAborted();
		// Sequential imports share one private cache. Each provider still receives
		// its own registration filter; a failure aborts the whole loader transaction.
		for (const { path, names } of providers.values()) {
			try {
				const factory = await jiti.import<unknown>(path, { default: true });
				signal.throwIfAborted();
				if (typeof factory !== "function") throw new Error("extension source must default-export a factory function");
				const registerTool: ExtensionAPI["registerTool"] = (tool) => {
					signal.throwIfAborted();
					if (names.has(tool.name)) pi.registerTool(tool);
				};
				const childApi = new Proxy(pi, {
					get(target, property, receiver) {
						if (property === "registerTool") return registerTool;
						if (property === "getFlag" && getFlag) return getFlag;
						return Reflect.get(target, property, receiver);
					},
				});
				await (factory as ExtensionFactory)(childApi);
				signal.throwIfAborted();
			} catch (error) {
				signal.throwIfAborted();
				throw sourceError(names, `loading ${JSON.stringify(path)} failed (${error instanceof Error ? error.message : String(error)}).`, error);
			}
		}
	} }];
}
