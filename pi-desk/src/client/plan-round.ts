import type { ChatMessage } from "../shared/protocol.ts";

/** Read the plan's versioned round envelope for display; never alter its stored prompt. */
export function planRoundNotice(message: Pick<ChatMessage, "role" | "blocks">): {
	objective: string; round: number; maxRounds: number;
} | undefined {
	const block = message.blocks[0];
	if (message.role !== "note" || message.blocks.length !== 1 || block?.type !== "text" || block.truncated || block.full) return;
	const text = block.text.trim();
	// The round message as pi-plan writes it now, and as it wrote it before November 2026.
	const current = /^<plan_round>Round (\d+) of (\d+)\. Objective: (.+)(?:\r?\nCurrent: (.+))?\r?\nContinue: [^\n]+<\/plan_round>$/.exec(text);
	const earlier = current ? undefined : /^<plan_round>\r?\nObjective: (.+)\r?\nRound: (\d+)\/(\d+)\r?\nPlan: (.+) revision (\d+)(?:\r?\nCurrent steps: (.+))?\r?\n\r?\n[\s\S]+\r?\n<\/plan_round>$/.exec(text);
	if (!current && !earlier) return;
	try {
		const objective: unknown = JSON.parse(current ? current[3]! : earlier![1]!);
		const round = Number(current ? current[1] : earlier![2]), maxRounds = Number(current ? current[2] : earlier![3]);
		const stepsText = current ? current[4] : earlier![6];
		const steps: unknown = stepsText === undefined ? [] : JSON.parse(stepsText);
		if (earlier && (typeof JSON.parse(earlier[4]!) !== "string" || !(Number(earlier[5]) > 0))) return;
		if (typeof objective !== "string" || !objective
			|| ![round, maxRounds].every(value => Number.isSafeInteger(value) && value > 0) || round > maxRounds
			|| !Array.isArray(steps) || !steps.every(step => typeof step === "string")) return;
		return { objective, round, maxRounds };
	} catch { return; }
}
