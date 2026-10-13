import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import { readOptional, replaceFile, withFileLocks } from "../pi-config/files.ts";

export const EXTENDED_WINDOW = 1_000_000;
export const EXTENDED_CHECKPOINT = 900_000;
export const EXTENDED_RESERVE = EXTENDED_WINDOW - EXTENDED_CHECKPOINT;
export const EXTENDED_CAPACITY = 1_050_000;

const LONG_CONTEXT_MODELS = new Set([
	"gpt-5.4", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro",
	"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
	"gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
]);

// The authenticated Codex model catalog's max_context_window (client 0.159.1, 13 October 2026), not its default
// 272k working budget. Codex Wire records the live value for each model it uses, which takes precedence.
const CODEX_CAPACITIES: Record<string, number> = {
	"gpt-5.5": 272_000, "gpt-5.6-sol": 872_000, "gpt-5.6-terra": 872_000, "gpt-5.6-luna": 872_000,
	"gpt-6-astra": 872_000, "gpt-6-sol": 872_000, "gpt-6-luna": 872_000, "gpt-6.1-sol": 872_000,
};
const liveKey = Symbol.for("pi.codex.max-context-window.v1");
const shared = globalThis as typeof globalThis & { [liveKey]?: Map<string, number> };
// Shared by every extension loader in this process.
const liveCapacities = shared[liveKey] ??= new Map();

export function recordCodexCapacity(modelId: string, capacity: unknown): void {
	if (Number.isSafeInteger(capacity) && (capacity as number) > 0) liveCapacities.set(modelId, capacity as number);
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
	return value as JsonObject;
}

function nested(parent: JsonObject, key: string, label: string): JsonObject {
	if (parent[key] === undefined) parent[key] = {};
	return object(parent[key], label);
}

function parse(text: string | undefined, label: string, initial: JsonObject): JsonObject {
	if (text === undefined) return initial;
	try { return object(JSON.parse(text), label); }
	catch (error) { throw new Error(`Cannot edit ${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

function cleanEmpty(parent: JsonObject, key: string): void {
	if (parent[key] && Object.keys(object(parent[key], key)).length === 0) delete parent[key];
}

/** The 1M preset. Codex models stop at their catalog limit (872,000), below it. */
export function allowsExtendedWindow(provider: string, modelId: string): boolean {
	return provider === "openai" && LONG_CONTEXT_MODELS.has(modelId);
}
/**
 * The most context a model accepts. For Codex this is the catalog's max_context_window, whatever budget is saved:
 * a gpt-6-astra budget of 922,000 let conversations grow past 872,000, so Pi never reached its checkpoint before
 * Codex rejected requests and compactions as too large.
 */
export function modelCapacity(model: { provider: string; id: string; contextWindow: number }): number {
	const codex = model.provider === "openai-codex" ? liveCapacities.get(model.id) ?? CODEX_CAPACITIES[model.id] : undefined;
	if (codex) return codex;
	const catalog = getBuiltinModels(model.provider as BuiltinProvider).find(item => item.id === model.id)?.contextWindow ?? 0;
	return Math.max(catalog, model.contextWindow, allowsExtendedWindow(model.provider, model.id) ? EXTENDED_CAPACITY : 0);
}

export function configuredWindow(text: string | undefined, provider: string, modelId: string): number | undefined {
	if (text === undefined) return undefined;
	const root = parse(text, "models.json", { providers: {} });
	const providers = object(root.providers, "providers");
	const entry = providers[provider];
	if (entry === undefined) return undefined;
	const overrides = object(object(entry, provider).modelOverrides ?? {}, "modelOverrides");
	const model = overrides[modelId];
	if (model === undefined) return undefined;
	const window = object(model, modelId).contextWindow;
	if (window === undefined) return undefined;
	if (!Number.isSafeInteger(window) || (window as number) <= 0) throw new Error("Invalid configured model context window");
	return window as number;
}

export function configuredReserve(text: string | undefined, provider: string, modelId: string): number | undefined {
	if (text === undefined) return undefined;
	const root = parse(text, "settings.json", {});
	const compaction = root.compaction;
	if (compaction === undefined) return undefined;
	const overrides = object(object(compaction, "compaction").modelOverrides ?? {}, "modelOverrides");
	const model = overrides[`${provider}/${modelId}`];
	if (model === undefined) return undefined;
	const reserve = object(model, "model compaction override").reserveTokens;
	if (reserve === undefined) return undefined;
	if (!Number.isSafeInteger(reserve) || (reserve as number) < 0) throw new Error("Invalid configured checkpoint reserve");
	return reserve as number;
}

export function modelWindowText(text: string | undefined, provider: string, modelId: string, window: number | undefined): string | undefined {
	if (configuredWindow(text, provider, modelId) === window) return text;
	const root = parse(text, "models.json", { providers: {} });
	const providers = nested(root, "providers", "providers");
	if (window !== undefined) {
		const config = nested(providers, provider, provider);
		nested(config, "modelOverrides", "modelOverrides");
		nested(config.modelOverrides as JsonObject, modelId, modelId).contextWindow = window;
	} else if (providers[provider] !== undefined) {
		const config = object(providers[provider], provider);
		if (config.modelOverrides !== undefined) {
			const overrides = object(config.modelOverrides, "modelOverrides");
			if (overrides[modelId] !== undefined) {
				const model = object(overrides[modelId], modelId);
				delete model.contextWindow;
				cleanEmpty(overrides, modelId);
			}
			cleanEmpty(config, "modelOverrides");
		}
		cleanEmpty(providers, provider);
	}
	return JSON.stringify(root, null, 2) + "\n";
}

export function checkpointText(text: string | undefined, provider: string, modelId: string, reserve: number | undefined): string | undefined {
	if (configuredReserve(text, provider, modelId) === reserve) return text;
	const root = parse(text, "settings.json", {});
	if (reserve !== undefined) {
		const compaction = nested(root, "compaction", "compaction");
		const overrides = nested(compaction, "modelOverrides", "modelOverrides");
		nested(overrides, `${provider}/${modelId}`, "model compaction override").reserveTokens = reserve;
	} else if (root.compaction !== undefined) {
		const compaction = object(root.compaction, "compaction");
		if (compaction.modelOverrides !== undefined) {
			const overrides = object(compaction.modelOverrides, "modelOverrides");
			const key = `${provider}/${modelId}`;
			if (overrides[key] !== undefined) {
				const model = object(overrides[key], "model compaction override");
				delete model.reserveTokens;
				cleanEmpty(overrides, key);
			}
			cleanEmpty(compaction, "modelOverrides");
		}
		cleanEmpty(root, "compaction");
	}
	return JSON.stringify(root, null, 2) + "\n";
}

export interface WindowPreset {
	provider: string;
	modelId: string;
	window: number | undefined;
	reserve: number | undefined;
}

/** Both files are read under their native settings lock before either is changed. */
export async function writeWindowPreset(preset: WindowPreset, options: {
	assertCurrent?: () => void; expected?: { window: number | undefined; reserve: number | undefined };
} = {}): Promise<boolean> {
	const dir = getAgentDir();
	const modelsPath = join(dir, "models.json");
	const settingsPath = join(dir, "settings.json");
	return withFileLocks([modelsPath, settingsPath], async () => {
		options.assertCurrent?.();
		const oldModels = readOptional(modelsPath);
		const oldSettings = readOptional(settingsPath);
		if (options.expected && (configuredWindow(oldModels, preset.provider, preset.modelId) !== options.expected.window ||
			configuredReserve(oldSettings, preset.provider, preset.modelId) !== options.expected.reserve))
			throw new Error("Context settings changed while the dialog was open. Reopen it before saving.");
		const newModels = modelWindowText(oldModels, preset.provider, preset.modelId, preset.window);
		const newSettings = checkpointText(oldSettings, preset.provider, preset.modelId, preset.reserve);
		if (newModels === oldModels && newSettings === oldSettings) return false;
		let modelsWritten = false;
		try {
			if (newModels !== oldModels) {
				await replaceFile(modelsPath, newModels, options.assertCurrent);
				modelsWritten = true;
			}
			if (newSettings !== oldSettings) await replaceFile(settingsPath, newSettings, options.assertCurrent);
		} catch (error) {
			if (modelsWritten) {
				try { await replaceFile(modelsPath, oldModels); }
				catch (rollback) { throw new AggregateError([error, rollback], "Context setting failed and the model setting could not be restored"); }
			}
			throw error;
		}
		return true;
	});
}

export function readWindowFiles(): { models: string | undefined; settings: string | undefined } {
	const dir = getAgentDir();
	return { models: readOptional(join(dir, "models.json")), settings: readOptional(join(dir, "settings.json")) };
}
