import type { UiView } from "../../pi-ui/index.ts";
import type { PlanView } from "./domain.ts";
import { stepSummary } from "./steps.ts";

export function planControls(plan?: PlanView) {
	if (!plan || plan.phase === "complete") return [
		{ id: "create", label: "Create plan" }, ...(plan ? [{ id: "clear", label: "Clear plan", destructive: true }] : []),
	];
	return [
		{ id: "objective", label: "Edit objective" }, { id: "add", label: "Add step" },
		{ id: "mode", label: "Continuation settings" },
		...(plan.phase === "active" ? [{ id: "pause", label: "Pause" }] : []),
		...(plan.phase === "paused" || plan.phase === "blocked" || (plan.autoContinue && plan.activation === "disarmed")
			? [{ id: "resume", label: "Resume" }] : []),
		...(plan.steps.every(step => step.status === "completed") ? [{ id: "complete", label: "Complete plan" }] : []),
		{ id: "clear", label: "Clear plan", destructive: true },
	];
}
export function planPresentation(plan: PlanView | undefined, error?: string): UiView {
	const summary = plan && stepSummary(plan.steps);
	return {
		kind: "details", title: "Plan",
		...(plan && summary ? { preview: { label: "Plan", primary: plan.objective,
			secondary: `${plan.phase} · ${summary.completed}/${summary.total} steps${summary.current ? ` · ${summary.current}` : ""}` } } : {}),
		data: {
			summary: error ?? plan?.objective ?? "No current plan.",
			fields: plan ? [
				{ label: "State", value: plan.phase },
				{ label: "Continuation", value: plan.autoContinue ? `Automatic · ${plan.activation}` : "Manual" },
				{ label: "Rounds", value: `${plan.roundsStarted}/${plan.maxRounds}` },
				{ label: "Revision", value: String(plan.revision) },
				...(plan.phase === "blocked" ? [{ label: "Blocker", value: plan.blockedReason.message }] : []),
			] : [],
			items: plan?.steps.map((step, index) => ({
				id: `step:${index}`, title: step.content, status: step.status.replaceAll("_", " "),
				...(plan.phase !== "complete" ? { actions: [
					{ id: `status:${index}`, label: "Status" }, { id: `edit:${index}`, label: "Edit" },
					{ id: `remove:${index}`, label: "Remove", destructive: true },
				] } : {}),
			})) ?? [],
		},
		actions: error ? [] : planControls(plan),
	};
}
