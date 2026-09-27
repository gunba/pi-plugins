export const STEP_STATUSES = ["pending", "in_progress", "completed"] as const;
export type StepStatus = typeof STEP_STATUSES[number];
export interface PlanStep { content: string; status: StepStatus }

/** Stored text stays exact; only new input is normalized. Parallel work is allowed. */
export function planSteps(value: unknown, normalize = false): PlanStep[] {
	if (!Array.isArray(value)) throw new Error("steps must be an array");
	const contents = new Set<string>();
	return value.map(candidate => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
			|| Object.keys(candidate).sort().join(",") !== "content,status") throw new Error("each step needs content and status");
		if (typeof candidate.content !== "string" || !candidate.content.trim()
			|| (!normalize && candidate.content !== candidate.content.trim())) throw new Error("step content must be a non-empty, normalized string");
		if (!STEP_STATUSES.includes(candidate.status)) throw new Error("step status must be pending, in_progress, or completed");
		const content = normalize ? candidate.content.trim() : candidate.content;
		if (contents.has(content)) throw new Error(`duplicate step: ${JSON.stringify(content)}`);
		contents.add(content);
		return { content, status: candidate.status };
	});
}

export function stepSummary(steps: readonly PlanStep[]) {
	const active = steps.filter(step => step.status === "in_progress");
	return {
		total: steps.length,
		completed: steps.filter(step => step.status === "completed").length,
		active: active.length,
		current: active[0]?.content ?? steps.find(step => step.status === "pending")?.content,
	};
}
