import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../../manage/store.ts";
import type { OperatorAvailability, OperatorMode } from "../shared/operator.ts";

export function operatorAvailability(directory: string): OperatorAvailability {
	let value: OperatorAvailability;
	try { value = JSON.parse(readFileSync(join(directory, "operator.json"), "utf8")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "present" }; throw error; }
	if (!value || !["present", "away"].includes(value.mode)) throw new Error("Invalid operator availability.");
	return { mode: value.mode };
}
export function setOperatorAvailability(directory: string, mode: OperatorMode): OperatorAvailability {
	if (!["present", "away"].includes(mode)) throw new Error("Choose Present or Away.");
	const value = { mode }; atomicJson(join(directory, "operator.json"), value); return value;
}
