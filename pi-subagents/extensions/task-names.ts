import { createHash } from "node:crypto";

export function validateTaskName(name: string): string {
	if (!/^[a-z0-9_]+$/.test(name) || name === "root")
		throw Error("task_name must use lowercase letters, digits or underscores and cannot be root");
	return name;
}

/** Stable routing for histories written before task names existed. */
export function historicalTaskName(id: string): string {
	const name = `agent_${id.replaceAll("-", "_")}`;
	return /^[a-z0-9_]+$/.test(name) ? name : `agent_${createHash("sha256").update(id).digest("hex")}`;
}

export function resolveTaskPath(current: string, target: string): string {
	const path = target.startsWith("/") ? target : `${current}/${target}`;
	const [empty, root, ...parts] = path.split("/");
	if (empty !== "" || root !== "root") throw Error("Agent paths must begin with /root");
	for (const part of parts) validateTaskName(part);
	return path;
}

export function parseForkTurns(value = "all"): "all" | "none" | number {
	const normalized = value.trim().toLowerCase() || "all";
	if (normalized === "all" || normalized === "none") return normalized;
	if (/^\+?[0-9]+$/.test(normalized) && Number.isSafeInteger(Number(normalized)) && Number(normalized) > 0) return Number(normalized);
	throw Error("fork_turns must be all, none, or a positive integer string");
}
