import path from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

const TITLE_PROMPT = `Name this session from the user's message.
Return only a short, natural topic label.
Name the actual subject, not setup actions or generic words.

Examples:
- Pull the latest and check for ATO corpus updates -> ATO Updates
- Fix the authentication request timeout -> Auth Timeout
- Improve the session resume picker UI -> Session Resume UI`;

export default function tabTitle(pi: ExtensionAPI): void {
	let firstPrompt: string | undefined;
	let attempted = false;

	const showTitle = (ctx: ExtensionContext, title?: string): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setTitle(title || path.basename(ctx.cwd) || "pi");
	};

	pi.on("session_start", async (_event, ctx) => {
		firstPrompt = findFirstUserPrompt(ctx.sessionManager.getBranch());
		attempted = Boolean(pi.getSessionName());
		showTitle(ctx, pi.getSessionName());
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.hasUI || attempted || pi.getSessionName()) return;
		attempted = true;

		const prompt = (firstPrompt || event.prompt).trim();
		if (!prompt) return;

		try {
			const title = await generateTitle(ctx, prompt);
			if (!title || pi.getSessionName()) return;
			pi.setSessionName(title);
			showTitle(ctx, title);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Tab title: ${message}`, "warning");
		}
	});

	pi.on("session_info_changed", async (event, ctx) => {
		showTitle(ctx, event.name);
	});
}

async function generateTitle(
	ctx: ExtensionContext,
	prompt: string,
): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;

	const message: Message = {
		role: "user",
		content: [{ type: "text", text: prompt.slice(0, 4_000) }],
		timestamp: Date.now(),
	};

	const response = await completeSimple(
		model,
		{ systemPrompt: TITLE_PROMPT, messages: [message] },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: 32,
			temperature: 0,
			reasoning: model.reasoning ? "minimal" : undefined,
			maxRetries: 0,
			timeoutMs: 8_000,
			signal: ctx.signal,
		},
	);

	return normalizeTitle(assistantText(response));
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join(" ");
}

function normalizeTitle(value: string): string | undefined {
	const title = value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, " ")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
		.replace(/[\x00-\x1f\x7f\x9b]/g, " ")
		.replace(/^\s*title\s*:\s*/i, "")
		.replace(/^[\s"'`*_]+|[\s"'`*_]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (!title) return undefined;
	return [...title].slice(0, 60).join("").trim();
}

function findFirstUserPrompt(
	entries: readonly SessionEntry[],
): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.flatMap((part) => (part.type === "text" ? [part.text] : []))
						.join("\n");
		if (text.trim()) return text.trim();
	}
	return undefined;
}
