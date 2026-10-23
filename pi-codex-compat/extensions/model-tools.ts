export type ModelDescriptor = {
	provider?: string;
	api?: string;
	id?: string;
	input?: string[];
};

export type ToolActivationCapabilities = {
	/** An image-generation service is signed in: the conversation's own model, or a ChatGPT (Codex) or OpenAI account. */
	imageGenerationAuthenticated?: boolean;
};

export type ToolActivationState = {
	enabled: boolean;
	eligibleToolNames?: string[];
	managedToolNames?: string[];
};

/** This adapter's tools; failed calls to them, and to image_gen, are marked as errors. */
export const CODEX_COMPAT_TOOL_NAMES = [
	"exec_command",
	"write_stdin",
	"view_image",
];
/**
 * The one tool switched on and off with the model: view_image, by what the model can see. Every model has the same
 * other tools: the process tools and image_gen are loaded with tool_search, whatever the model. Codex models once had
 * the process tools declared for them; switching models then added and removed tools, which breaks the prompt cache.
 */
export const MODEL_TOOL_NAMES = ["view_image"];

export const CODEX_TOOL_OUTPUT_TOKEN_BUDGET = 10_000;

function mergeToolNames(...groups: string[][]): string[] {
	return [...new Set(groups.flat())];
}

function withoutModelTools(toolNames: string[]): string[] {
	return toolNames.filter((name) => !MODEL_TOOL_NAMES.includes(name));
}

function normalized(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

function isGptModelId(id: string): boolean {
	return /^gpt-\d(?:[.\d-]|$)/.test(id);
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

/**
 * The model whose account and endpoint image_gen uses. The image request goes to that service whatever model the
 * conversation chats with, so a Claude conversation can use a signed-in ChatGPT (Codex) account. The conversation's
 * own model comes first when it can generate images; otherwise a signed-in Codex model, then an OpenAI API one.
 */
export function imageGenerationService<T extends ModelDescriptor>(
	current: T | null | undefined,
	signedIn: readonly T[],
): T | undefined {
	if (current && isImageGenerationModel(current)) return current;
	const eligible = signedIn.filter(model => isImageGenerationModel(model));
	return eligible.find(model => isChatGptCodexModel(model)) ?? eligible[0];
}

export function toolsForModel(
	model: ModelDescriptor | null | undefined,
	capabilities: ToolActivationCapabilities = {},
): string[] {
	if (!model) return [];
	const canGenerateImages = capabilities.imageGenerationAuthenticated === true;
	// A text-only model views images through its own provider, so that still needs an image-generation model here.
	return model.input?.includes("image") || canGenerateImages && isImageGenerationModel(model) ? ["view_image"] : [];
}

export function syncCodexCompatTools(
	activeTools: string[],
	model: ModelDescriptor | null | undefined,
	state: ToolActivationState,
	capabilities: ToolActivationCapabilities = {},
): { activeTools: string[]; state: ToolActivationState } {
	const activeOwnedTools = activeTools.filter((name) =>
		MODEL_TOOL_NAMES.includes(name),
	);
	let eligibleToolNames = state.eligibleToolNames
		? [...state.eligibleToolNames]
		: activeOwnedTools;

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

	const adapterTools = toolsForModel(model, capabilities).filter((name) =>
		eligibleToolNames.includes(name),
	);
	const base = withoutModelTools(activeTools);
	return {
		activeTools: mergeToolNames(base, adapterTools),
		state: {
			enabled: adapterTools.length > 0,
			eligibleToolNames,
			managedToolNames: adapterTools,
		},
	};
}
