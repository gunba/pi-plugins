import type { WorkSection } from "./view.ts";
import type { PlanView } from "../pi-plan/src/domain.ts";
import { stepSummary } from "../pi-plan/src/steps.ts";

export function planWorkSection(plan: PlanView | undefined, error?: string): WorkSection | undefined {
	if (error !== undefined) return { label: "Plan", status: "! unavailable", summary: "History unavailable", tone: "error", detail: error };
	if (!plan) return undefined;
	const progress = stepSummary(plan.steps), mode = plan.autoContinue ? plan.activation : "manual";
	return {
		label: "Plan", status: `${plan.phase} · ${progress.completed}/${progress.total} · ${mode}`,
		summary: `${plan.objective}${progress.current ? ` → ${progress.current}` : ""}`,
		tone: plan.phase === "blocked" ? "warning" : plan.phase === "complete" ? "success" : plan.phase === "paused" ? "muted" : "accent",
		detail: [
			plan.objective, "", `State: ${plan.phase} · ${mode}`,
			`Automatic rounds: ${plan.roundsStarted}/${plan.maxRounds}`,
			`Revision: ${plan.revision} · ID: ${plan.id}`,
			...(plan.phase === "blocked" ? ["", `Blocked: ${plan.blockedReason.message}`] : []), "",
			...plan.steps.map(step => `${step.status === "completed" ? "✓" : step.status === "in_progress" ? "◉" : "○"} [${step.status.replaceAll("_", " ")}] ${step.content}`),
			"", "Manage with /plan.",
		].join("\n"),
	};
}

interface AgentState {
	id: string;
	label: string;
	state: "running" | "waiting" | "settled" | "error" | "aborted";
	activity?: string;
	diagnosticReason?: string;
	errorMessage?: string;
}
export function subagentWorkSection(agents: readonly AgentState[]): WorkSection | undefined {
	if (!agents.length) return undefined;
	const attention = agents.filter((agent) => agent.state === "error" || agent.state === "aborted" || agent.diagnosticReason);
	const running = agents.filter((agent) => agent.state === "running");
	const waiting = agents.filter((agent) => agent.state === "waiting");
	const ready = agents.filter((agent) => agent.state === "settled");
	const current = attention[0] ?? waiting[0] ?? running[0];
	return {
		label: "Subagents",
		status: [
			...(attention.length ? [`! ${attention.length} attention`] : []),
			`${running.length} running`,
			...(waiting.length ? [`${waiting.length} waiting`] : []),
			...(ready.length ? [`${ready.length} ready`] : []),
		].join(" · "),
		summary: current ? `${current.label}${current.activity ? `: ${current.activity}` : ""}` : undefined,
		tone: attention.length ? "error" : waiting.length ? "warning" : running.length ? "accent" : "success",
		detail: [
			"/subagents opens the dashboard with transcripts, follow-up and interrupt actions.", "",
			...agents.map((agent) => `${agent.label} · ${agent.state} · ${agent.id}${agent.activity ? `\n${agent.activity}` : ""}${agent.diagnosticReason ? `\nDiagnostic: ${agent.diagnosticReason}` : ""}${agent.errorMessage ? `\nError: ${agent.errorMessage}` : ""}`),
		].join("\n\n"),
	};
}
