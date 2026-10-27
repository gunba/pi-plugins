import { createHash } from "node:crypto";
import { isModelType, type ImageModel, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateImages, IMAGE_API, IMAGE_MODELS } from "./images.ts";

const fingerprint = (token: string) => createHash("sha256").update(token).digest("hex");

/** Adds image operations without replacing chat, classifiers, authentication, or provider-owned catalog refresh. */
export function withOpenAIImages(base: Provider): Provider {
	if (base.id !== "openai" && base.id !== "openai-codex") return base;
	const images: ImageModel<typeof IMAGE_API>[] = IMAGE_MODELS.flatMap(id => [id, `${id}-2026-09-08`]).map(id => ({
		type: "image", id, provider: base.id, name: id.replace("gpt-image-2.5-", "GPT Image 2.5 "), api: IMAGE_API,
		baseUrl: base.baseUrl ?? (base.id === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api"),
		input: ["text", "image"], output: ["image"], cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 },
	}));
	// Native request options omit the credential type. Bounded fingerprints distinguish resolved OAuth tokens
	// from explicit API-key overrides without retaining a second copy of the credentials.
	const unsupportedTokens = new Set<string>();
	const oauth = base.id === "openai" ? base.auth.oauth : undefined;
	return {
		...base,
		auth: oauth ? { ...base.auth, oauth: { ...oauth, async toAuth(credential) {
			const auth = await oauth.toAuth(credential);
			if (auth.apiKey) {
				unsupportedTokens.add(fingerprint(auth.apiKey));
				if (unsupportedTokens.size > 32) unsupportedTokens.delete(unsupportedTokens.values().next().value!);
			}
			return auth;
		} } } : base.auth,
		getAllModels() {
			const original = base.getAllModels?.() ?? base.getModels();
			return [...original, ...images.filter(image => !original.some(model => model.type === "image" && model.id === image.id))];
		},
		filterAllModels(models, credential) {
			const filtered = base.filterAllModels?.(models, credential) ?? (base.filterModels
				? [...base.filterModels(models.filter(model => isModelType(model, "chat")), credential), ...models.filter(model => model.type && model.type !== "chat")]
				: models);
			// The public Sign in with ChatGPT preview excludes image generation, unlike the legacy Codex image service.
			return base.id === "openai" && credential?.type === "oauth" ? filtered.filter(model => model.type !== "image" || model.api !== IMAGE_API) : filtered;
		},
		generateImages(model, context, options) {
			if (model.api === IMAGE_API) return generateImages(model, context, options, token => unsupportedTokens.has(fingerprint(token)));
			return base.generateImages ? base.generateImages(model, context, options) : Promise.resolve({ api: model.api,
				provider: model.provider, model: model.id, output: [], stopReason: "error", timestamp: Date.now(), errorMessage: `Unsupported image API: ${model.api}` });
		},
	};
}

export default function openAIImages(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		for (const id of ["openai", "openai-codex"]) {
			const base = ctx.modelRegistry.getProvider(id);
			if (base && !base.getAllModels?.().some(model => model.type === "image" && model.api === IMAGE_API)) pi.registerProvider(withOpenAIImages(base));
		}
	});
}
