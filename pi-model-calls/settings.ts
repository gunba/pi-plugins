import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ServiceUsage } from "../pi-service-usage/index.ts";

/** The model ask_model uses on this computer, chosen in Desk's Settings, and the API key it is billed to. */
export interface ModelCalls { provider: string; model: string; effort: string; apiKey: string; dailyLimit: number }
/** What Settings sees; the key never leaves the computer. */
export interface ModelCallsView { provider?: string; model?: string; effort?: string; key: boolean; dailyLimit: number; spentToday: number }

/** The ledger's operation name; the daily limit counts it across providers. */
export const OPERATION = "ask_model";
export const DEFAULT_DAILY_LIMIT = 5;
const FILE = "model-calls.json";

/** Read per call, so a change in Settings applies to running conversations at once. */
export function modelCalls(agentDir = getAgentDir()): Partial<ModelCalls> {
	let saved: Record<string, unknown>;
	try { saved = JSON.parse(readFileSync(join(agentDir, FILE), "utf8")); } catch { return {}; }
	if (!saved || typeof saved !== "object") return {};
	const text = (key: string) => typeof saved[key] === "string" && (saved[key] as string).trim() ? (saved[key] as string).trim() : undefined;
	const limit = saved.dailyLimit;
	return { provider: text("provider"), model: text("model"), effort: text("effort"), apiKey: text("apiKey"),
		dailyLimit: typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_DAILY_LIMIT };
}

export function spentToday(agentDir = getAgentDir()): number {
	const usage = new ServiceUsage(agentDir);
	try { return usage.spentToday(OPERATION); }
	finally { usage.close(); }
}

export function modelCallsView(agentDir = getAgentDir()): ModelCallsView {
	const { provider, model, effort, apiKey, dailyLimit } = modelCalls(agentDir);
	let spent = 0;
	try { spent = spentToday(agentDir); } catch {}
	return { ...(provider && model && effort ? { provider, model, effort } : {}), key: !!apiKey, dailyLimit: dailyLimit ?? DEFAULT_DAILY_LIMIT, spentToday: spent };
}

/**
 * Save the choice, or remove it with undefined. Without a new key, the saved one is kept for the same provider;
 * a key belongs to one provider, so another provider needs its own.
 */
export function saveModelCalls(choice: Omit<ModelCalls, "apiKey"> & { apiKey?: string } | undefined, agentDir = getAgentDir()): void {
	const file = join(agentDir, FILE);
	if (!choice) { rmSync(file, { force: true }); return; }
	const saved = modelCalls(agentDir);
	const apiKey = choice.apiKey ?? (saved.provider === choice.provider ? saved.apiKey : undefined);
	if (!apiKey) throw new Error("Enter an API key for this provider.");
	if (!/^[\x21-\x7e]{1,2000}$/.test(apiKey)) throw new Error("Paste the API key without spaces.");
	if (!Number.isFinite(choice.dailyLimit) || choice.dailyLimit <= 0 || choice.dailyLimit > 10_000) throw new Error("Set a daily limit between $0.01 and $10,000.");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const temp = file + "." + randomUUID() + ".tmp";
	try {
		writeFileSync(temp, JSON.stringify({ provider: choice.provider, model: choice.model, effort: choice.effort, apiKey, dailyLimit: choice.dailyLimit }, null, 2) + "\n", { mode: 0o600 });
		renameSync(temp, file);
	} finally { rmSync(temp, { force: true }); }
}
