export type ModelDescriptor = {
	provider?: string;
	api?: string;
	id?: string;
	input?: string[];
};

export type ToolActivationCapabilities = {
	imageGenerationAuthenticated?: boolean;
};

export type ToolActivationState = {
	enabled: boolean;
	eligibleToolNames?: string[];
	managedToolNames?: string[];
};

export const CODEX_COMPAT_TOOL_NAMES = [
	"apply_patch",
	"exec_command",
	"write_stdin",
	"view_image",
	"image_gen",
];

export const CODEX_TOOL_OUTPUT_TOKEN_BUDGET = 10_000;

/**
 * Pi's built-in bash remains visible by design. An extension cannot suppress it
 * and later distinguish its own suppression from a user's manual disablement.
 * Keeping it avoids resurrecting user-disabled state and preserves the richer
 * host-owned bash behavior while Unified Exec remains a plain-pipe fallback.
 */
export const PRESERVE_BUILTIN_BASH = true;

function mergeToolNames(...groups: string[][]): string[] {
	return [...new Set(groups.flat())];
}

function withoutCodexCompatTools(toolNames: string[]): string[] {
	return toolNames.filter((name) => !CODEX_COMPAT_TOOL_NAMES.includes(name));
}

function normalized(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

function isGptModelId(id: string): boolean {
	return id === "gpt-5" || id.startsWith("gpt-5-") || id.startsWith("gpt-5.");
}

function isCopilotProvider(provider: string): boolean {
	return provider === "github-copilot" || provider === "copilot";
}

function isCodexProvider(provider: string): boolean {
	return (
		provider === "codex" ||
		provider === "openai-codex" ||
		provider === "chatgpt"
	);
}

export function isCodexLikeModel(
	model: ModelDescriptor | null | undefined,
): boolean {
	if (!model) return false;
	const provider = normalized(model.provider);
	const api = normalized(model.api);
	const id = normalized(model.id);
	if (api === "openai-codex-responses" || isCodexProvider(provider))
		return true;
	if (provider === "openai" && isGptModelId(id)) return true;
	return isCopilotProvider(provider) && isGptModelId(id);
}

export function isChatGptCodexModel(
	model: ModelDescriptor | null | undefined,
): boolean {
	if (!model) return false;
	const provider = normalized(model.provider);
	const api = normalized(model.api);
	return api === "openai-codex-responses" || isCodexProvider(provider);
}

export function isImageGenerationModel(
	model: ModelDescriptor | null | undefined,
): boolean {
	if (!model || !isCodexLikeModel(model)) return false;
	const provider = normalized(model.provider);
	const id = normalized(model.id);
	if (
		provider === "anthropic" ||
		id === "claude" ||
		id.startsWith("claude-") ||
		isCopilotProvider(provider)
	) {
		return false;
	}
	return provider === "openai" || isCodexProvider(provider);
}

export function toolsForModel(
	model: ModelDescriptor | null | undefined,
	capabilities: ToolActivationCapabilities = {},
): string[] {
	if (!isCodexLikeModel(model)) return [];
	const tools = ["apply_patch", "exec_command", "write_stdin"];
	const canGenerateImages =
		capabilities.imageGenerationAuthenticated === true &&
		isImageGenerationModel(model);
	if (model?.input?.includes("image") || canGenerateImages) {
		tools.push("view_image");
	}
	if (canGenerateImages) tools.push("image_gen");
	return tools;
}

export function syncCodexCompatTools(
	activeTools: string[],
	model: ModelDescriptor | null | undefined,
	state: ToolActivationState,
	capabilities: ToolActivationCapabilities = {},
): { activeTools: string[]; state: ToolActivationState } {
	const activeOwnedTools = activeTools.filter((name) =>
		CODEX_COMPAT_TOOL_NAMES.includes(name),
	);
	let eligibleToolNames = state.eligibleToolNames
		? [...state.eligibleToolNames]
		: [...activeOwnedTools];

	if (state.enabled) {
		const manuallyDisabled = new Set(
			(state.managedToolNames ?? []).filter(
				(name) => !activeOwnedTools.includes(name),
			),
		);
		eligibleToolNames = eligibleToolNames.filter(
			(name) => !manuallyDisabled.has(name),
		);
	}
	eligibleToolNames = mergeToolNames(eligibleToolNames, activeOwnedTools);

	const base = withoutCodexCompatTools(activeTools);
	const adapterTools = toolsForModel(model, capabilities).filter((name) =>
		eligibleToolNames.includes(name),
	);
	return {
		activeTools: mergeToolNames(base, adapterTools),
		state: {
			enabled: adapterTools.length > 0,
			eligibleToolNames,
			managedToolNames: adapterTools,
		},
	};
}
