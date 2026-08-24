import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	GOAL_COMMAND_VERSION,
	GOAL_STATUS_KEY,
	GOAL_WIDGET_KEY,
} from "./constants.ts";
import type { GoalCommandResult } from "./command.ts";
import type { GoalView } from "./domain.ts";
import type { GoalRoundDetails } from "./replay.ts";

export interface GoalCommandEntryData {
	version: typeof GOAL_COMMAND_VERSION;
	input: string;
	result: GoalCommandResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeGoalCommandEntry(value: unknown): GoalCommandEntryData | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.keys(value).sort().join(",") !== "input,result,version") return undefined;
	if (value.version !== GOAL_COMMAND_VERSION || typeof value.input !== "string" || !isRecord(value.result)) {
		return undefined;
	}
	if (Object.keys(value.result).sort().join(",") !== "kind,text") return undefined;
	if (
		(value.result.kind !== "success" && value.result.kind !== "error") ||
		typeof value.result.text !== "string"
	) return undefined;
	return {
		version: GOAL_COMMAND_VERSION,
		input: value.input,
		result: { kind: value.result.kind, text: value.result.text },
	};
}

export function renderGoalCommandEntry(data: unknown, theme: Theme): Box | undefined {
	const decoded = decodeGoalCommandEntry(data);
	if (decoded === undefined) return undefined;
	const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
	const color = decoded.result.kind === "error" ? "error" : "customMessageLabel";
	const heading = theme.fg(color, theme.bold(decoded.input.trimEnd() || "/goal"));
	box.addChild(new Text(`${heading}\n${theme.fg("customMessageText", decoded.result.text)}`, 0, 0));
	return box;
}

export function renderGoalRoundMessage(
	content: unknown,
	details: GoalRoundDetails | undefined,
	expanded: boolean,
	theme: Theme,
	outputPad: number,
): Box | undefined {
	if (details === undefined || typeof content !== "string") return undefined;
	const objective = content.split("\n").find((line) => line.startsWith("Objective: ")) ?? "Objective";
	const title = theme.fg(
		"customMessageLabel",
		theme.bold(`Goal round ${details.round}`),
	);
	const body = expanded ? content : objective;
	const box = new Box(outputPad, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(`${title}\n${theme.fg("customMessageText", body)}`, 0, 0));
	return box;
}

export function updateGoalUi(
	ctx: ExtensionContext,
	goal: GoalView | undefined,
	corruption?: string,
): void {
	if (corruption !== undefined) {
		ctx.ui.setStatus(GOAL_STATUS_KEY, ctx.ui.theme.fg("error", "goal corrupt"));
		ctx.ui.setWidget(GOAL_WIDGET_KEY, [
			ctx.ui.theme.fg("error", "Goal history is corrupt."),
			ctx.ui.theme.fg("dim", corruption),
		]);
		return;
	}
	if (goal === undefined) {
		ctx.ui.setStatus(GOAL_STATUS_KEY, undefined);
		ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined);
		return;
	}
	const phaseColor = goal.phase === "blocked"
		? "warning"
		: goal.phase === "complete"
			? "success"
			: "accent";
	const activation = goal.phase === "active" ? ` · ${goal.activation}` : "";
	ctx.ui.setStatus(
		GOAL_STATUS_KEY,
		ctx.ui.theme.fg(
			phaseColor,
			`goal ${goal.phase}${activation} · ${goal.roundsStarted}/${goal.maxGoalRounds}`,
		),
	);
	if (goal.phase === "complete") {
		ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined);
		return;
	}
	const lines = [
		`${ctx.ui.theme.fg("accent", ctx.ui.theme.bold("Goal"))} ${goal.objective}`,
	];
	if (goal.phase === "blocked") {
		lines.push(ctx.ui.theme.fg(
			"warning",
			`Blocked: ${goal.blockedReason.code}: ${goal.blockedReason.message}`,
		));
	}
	ctx.ui.setWidget(GOAL_WIDGET_KEY, lines);
}

export function clearGoalUi(ctx: ExtensionContext): void {
	ctx.ui.setStatus(GOAL_STATUS_KEY, undefined);
	ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined);
}
