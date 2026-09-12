import type { WorkSection } from "./view.ts";

interface GoalState {
	id: string;
	revision: number;
	objective: string;
	phase: "active" | "paused" | "blocked" | "complete";
	activation: string;
	roundsStarted: number;
	maxGoalRounds: number;
	blockedReason?: { code: string; message: string };
}

export function goalWorkSection(goal: GoalState | undefined, corruption?: string): WorkSection | undefined {
	if (corruption !== undefined) return {
		label: "Goal", status: "! corrupt", summary: "History unavailable", tone: "error",
		detail: `Goal history is corrupt.\n\n${corruption}`,
	};
	if (!goal) return undefined;
	const activation = goal.phase === "active" ? ` · ${goal.activation}` : "";
	return {
		label: "Goal",
		status: `${goal.phase === "blocked" ? "! " : ""}${goal.phase}${activation} · ${goal.roundsStarted}/${goal.maxGoalRounds}`,
		summary: goal.objective,
		tone: goal.phase === "blocked" ? "warning" : goal.phase === "complete" ? "success" : goal.phase === "paused" ? "muted" : "accent",
		detail: [
			goal.objective,
			"",
			`State: ${goal.phase} · ${goal.activation}`,
			`Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds} · Revision: ${goal.revision} · ID: ${goal.id}`,
			...(goal.blockedReason ? ["", `Blocked: ${goal.blockedReason.code}: ${goal.blockedReason.message}`] : []),
			"", "Manage with /goal; viewing this panel does not change or resume the goal.",
		].join("\n"),
	};
}

interface TodoState { content: string; status: "pending" | "in_progress" | "completed" }
export function todoWorkSection(todos: readonly TodoState[] | null): WorkSection | undefined {
	if (!todos?.length) return undefined;
	const done = todos.filter((todo) => todo.status === "completed").length;
	const active = todos.filter((todo) => todo.status === "in_progress");
	const pending = todos.filter((todo) => todo.status === "pending");
	const current = active[0] ?? pending[0] ?? todos[todos.length - 1];
	return {
		label: "Todos", status: `${done}/${todos.length} done · ${active.length} active · ${pending.length} pending`,
		summary: `${current.content}${active.length > 1 ? ` (+${active.length - 1} active)` : ""}`,
		tone: done === todos.length ? "success" : active.length ? "accent" : "muted",
		detail: todos.map((todo) => `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◉" : "○"} [${todo.status.replaceAll("_", " ")}] ${todo.content}`).join("\n\n"),
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
