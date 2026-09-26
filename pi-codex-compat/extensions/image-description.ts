import { randomUUID } from "node:crypto";
import type { Api, Message, Usage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NativeImageContent } from "./image-content.ts";

const DESCRIPTION_SYSTEM_PROMPT = `You are a visual inspection assistant for a coding agent whose active model cannot process images. Describe only visible facts that may matter to the task. Include visible text verbatim, layout, controls, errors, dimensions, colors, and notable visual state. Be concise, structured, and explicit about anything unreadable. Do not speculate.`;

function imageCapable(model: Model<Api>): boolean {
	return model.input?.includes("image") === true;
}

function descriptionCandidates(ctx: ExtensionContext): Model<Api>[] {
	const current = ctx.model;
	if (!current) return [];
	return ctx.modelRegistry
		.getAll()
		.filter(
			(model) =>
				model.provider === current.provider && imageCapable(model),
		)
		.sort((a, b) => {
			const aSameApi = a.api === current.api ? 0 : 1;
			const bSameApi = b.api === current.api ? 0 : 1;
			if (aSameApi !== bSameApi) return aSameApi - bSameApi;
			const aMini = /mini/i.test(a.id) ? 0 : 1;
			const bMini = /mini/i.test(b.id) ? 0 : 1;
			if (aMini !== bMini) return aMini - bMini;
			return a.id.localeCompare(b.id);
		});
}

export async function describeImageForTextModel(
	image: NativeImageContent,
	path: string,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<{ description: string; model: string; usage: Usage }> {
	signal?.throwIfAborted();
	let selectedModel: Model<Api> | undefined;
	for (const candidate of descriptionCandidates(ctx)) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate);
		signal?.throwIfAborted();
		if (!auth.ok || !auth.apiKey) continue;
		selectedModel = candidate;
		break;
	}
	if (!selectedModel) {
		throw new Error("no authenticated image-capable model is configured");
	}

	const message: Message = {
		role: "user",
		content: [
			{
				type: "text",
				text: `Describe the image loaded from ${path} for the active coding agent.`,
			},
			image,
		],
		timestamp: Date.now(),
	};
	// The session runtime owns current authentication, endpoint overrides and Wire.
	// A nested image request must not reuse the parent's in-flight routing session.
	const response = await ctx.modelRegistry.complete(
		selectedModel,
		{ systemPrompt: DESCRIPTION_SYSTEM_PROMPT, messages: [message] },
		{
			sessionId: randomUUID(),
			signal,
		},
	);
	if (response.stopReason === "aborted") throw new Error("image description aborted");
	const description = response.content
		.flatMap((content) => (content.type === "text" ? [content.text.trim()] : []))
		.filter(Boolean)
		.join("\n");
	if (!description) throw new Error("image-capable model returned no description");
	return {
		description,
		usage: response.usage,
		model: `${selectedModel.provider}/${selectedModel.id}`,
	};
}
