export type ModelDescriptor = {
	provider?: string;
	api?: string;
	id?: string;
	input?: string[];
};

export type ToolActivationState = {
	enabled: boolean;
	previousToolNames: string[];
	eligibleToolNames?: string[];
};

export const CODEX_COMPAT_TOOL_NAMES = [
	"apply_patch",
	"shell_command",
	"write_stdin",
	"view_image",
];

function mergeToolNames(...groups: string[][]): string[] {
	return [...new Set(groups.flat())];
}

function withoutCodexCompatTools(toolNames: string[]): string[] {
	return toolNames.filter((name) => !CODEX_COMPAT_TOOL_NAMES.includes(name));
}

export function isCodexLikeModel(model: ModelDescriptor | null | undefined): boolean {
	if (!model) return false;
	const provider = (model.provider ?? "").toLowerCase();
	const api = (model.api ?? "").toLowerCase();
	const id = (model.id ?? "").toLowerCase();
	const isCopilotGpt =
		(provider.includes("copilot") || api.includes("copilot")) &&
		id.includes("gpt");
	return (
		provider.includes("codex") ||
		api.includes("codex") ||
		id.includes("codex") ||
		(provider.includes("openai") && id.includes("gpt")) ||
		isCopilotGpt
	);
}

export function toolsForModel(model: ModelDescriptor | null | undefined): string[] {
	if (!isCodexLikeModel(model)) return [];
	const tools = ["apply_patch", "shell_command", "write_stdin"];
	if (model?.input?.includes("image")) tools.push("view_image");
	return tools;
}

export function syncCodexCompatTools(
	activeTools: string[],
	model: ModelDescriptor | null | undefined,
	state: ToolActivationState,
): { activeTools: string[]; state: ToolActivationState } {
	const activeOwnedTools = activeTools.filter((name) =>
		CODEX_COMPAT_TOOL_NAMES.includes(name),
	);
	const eligibleToolNames = mergeToolNames(
		state.eligibleToolNames ?? [],
		activeOwnedTools,
	);
	const currentBase = withoutCodexCompatTools(activeTools);
	const base = state.enabled
		? mergeToolNames(state.previousToolNames, currentBase)
		: currentBase;
	const adapterTools = toolsForModel(model).filter((name) =>
		eligibleToolNames.includes(name),
	);
	if (adapterTools.length === 0) {
		return {
			activeTools: base,
			state: { enabled: false, previousToolNames: [], eligibleToolNames },
		};
	}
	return {
		activeTools: mergeToolNames(base, adapterTools),
		state: { enabled: true, previousToolNames: base, eligibleToolNames },
	};
}
