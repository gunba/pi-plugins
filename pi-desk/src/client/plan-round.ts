import type { ChatMessage } from "../shared/protocol.ts";

/** Read the plan's versioned round envelope for display; never alter its stored prompt. */
export function planRoundNotice(message: Pick<ChatMessage, "role" | "blocks">): {
	objective: string; round: number; maxRounds: number;
} | undefined {
	const block = message.blocks[0];
	if (message.role !== "note" || message.blocks.length !== 1 || block?.type !== "text" || block.truncated || block.full) return;
	const match = /^<plan_round>\r?\nObjective: (.+)\r?\nRound: (\d+)\/(\d+)\r?\nPlan: (.+) revision (\d+)(?:\r?\nCurrent steps: (.+))?\r?\n\r?\n[\s\S]+\r?\n<\/plan_round>$/.exec(block.text.trim());
	if (!match) return;
	try {
		const objective: unknown = JSON.parse(match[1]!);
		const round = Number(match[2]), maxRounds = Number(match[3]), revision = Number(match[5]);
		const id: unknown = JSON.parse(match[4]!);
		const steps: unknown = match[6] === undefined ? [] : JSON.parse(match[6]);
		if (typeof objective !== "string" || !objective || typeof id !== "string" || !id
			|| ![round, maxRounds, revision].every(value => Number.isSafeInteger(value) && value > 0) || round > maxRounds
			|| !Array.isArray(steps) || !steps.every(step => typeof step === "string")) return;
		return { objective, round, maxRounds };
	} catch { return; }
}
