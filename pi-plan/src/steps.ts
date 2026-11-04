export const STEP_STATUSES = ["pending", "in_progress", "completed"] as const;
export type StepStatus = typeof STEP_STATUSES[number];
/** detail: the agent's notes for the step (how to do it, files, findings), shown to it again while the step is current. */
export interface PlanStep { content: string; status: StepStatus; detail?: string }

/** Stored text stays exact; only new input is normalized. Parallel work is allowed. */
export function planSteps(value: unknown, normalize = false): PlanStep[] {
	if (!Array.isArray(value)) throw new Error("steps must be an array of step texts or {content, status} objects");
	const contents = new Set<string>();
	return value.map(candidate => {
		const keys = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? Object.keys(candidate).sort().join(",") : "";
		if (keys !== "content,status" && keys !== "content,detail,status") throw new Error("each step needs content and status, and may have detail");
		if (typeof candidate.content !== "string" || !candidate.content.trim()
			|| (!normalize && candidate.content !== candidate.content.trim())) throw new Error("step content must be a non-empty, normalized string");
		if (!STEP_STATUSES.includes(candidate.status)) throw new Error("step status must be pending, in_progress, or completed");
		if (candidate.detail !== undefined && (typeof candidate.detail !== "string"
			|| (!normalize && (!candidate.detail.trim() || candidate.detail !== candidate.detail.trim())))) throw new Error("step detail must be text");
		const content = normalize ? candidate.content.trim() : candidate.content;
		if (contents.has(content)) throw new Error(`duplicate step: ${JSON.stringify(content)}`);
		contents.add(content);
		// Empty detail, as new input, removes the step's detail.
		const detail = normalize ? candidate.detail?.trim() : candidate.detail;
		return { content, status: candidate.status, ...(detail ? { detail } : {}) };
	});
}

/** The steps being worked on: those in progress, or else the next pending one. */
export function currentSteps(steps: readonly PlanStep[]): PlanStep[] {
	const active = steps.filter(step => step.status === "in_progress");
	return active.length ? active : steps.filter(step => step.status === "pending").slice(0, 1);
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
