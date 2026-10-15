import { extname } from "node:path";
import {
	type AgentToolResult, type ExtensionAPI, type ExtensionContext, type Theme, type ToolRenderResultOptions,
	convertToPng, withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { fitForConversation, prepareNativeImageContent } from "./image-content.ts";
import { describeImageForTextModel } from "./image-description.ts";
import {
	IMAGE_GENERATION_MODELS, type ImageGenerationDetails, type ImageGenerationParams,
	executeImageGeneration, prepareImageGenerationArguments,
} from "./image-generation.ts";
import { MAX_LOCAL_IMAGE_BYTES, readLocalImageFile } from "./image-limits.ts";
import { displayPath, displayPathFromCwd, resolveToolPath } from "./paths.ts";
import { prepareViewImageArguments } from "./tool-arguments.ts";
import { resultText } from "./tool-rendering.ts";

type ViewImageParams = { path: string };
type ViewImageDetails = {
	path: string;
	mediaType: string;
	bytes: number;
	describedBy?: string;
	error?: string;
};

function mediaTypeForPath(path: string): string | undefined {
	switch (extname(path).toLowerCase()) {
		case ".png": return "image/png";
		case ".jpg": case ".jpeg": return "image/jpeg";
		case ".gif": return "image/gif";
		case ".webp": return "image/webp";
		case ".bmp": return "image/bmp";
		default: return undefined;
	}
}

function viewImageFailure(path: string, mediaType: string, bytes: number, message: string): AgentToolResult<ViewImageDetails> {
	return {
		content: [{ type: "text", text: `view_image failed: ${message}` }],
		details: { path, mediaType, bytes, error: message },
	};
}

async function executeViewImage(
	params: ViewImageParams, ctx: ExtensionContext, signal?: AbortSignal,
): Promise<AgentToolResult<ViewImageDetails>> {
	let absolutePath: string;
	try {
		absolutePath = resolveToolPath(ctx.cwd, params.path);
	} catch (error) {
		return viewImageFailure(params.path, "application/octet-stream", 0, error instanceof Error ? error.message : String(error));
	}
	const mediaType = mediaTypeForPath(absolutePath);
	if (!mediaType) {
		return viewImageFailure(absolutePath, "application/octet-stream", 0,
			`unsupported image extension for ${displayPath(ctx, absolutePath)}`);
	}
	let bytes: Buffer;
	try {
		bytes = await readLocalImageFile(absolutePath, displayPath(ctx, absolutePath), MAX_LOCAL_IMAGE_BYTES);
	} catch (error) {
		return viewImageFailure(absolutePath, mediaType, 0, error instanceof Error ? error.message : String(error));
	}
	let image: Awaited<ReturnType<typeof prepareNativeImageContent>>;
	try {
		image = await prepareNativeImageContent({ data: bytes.toString("base64"), mimeType: mediaType }, convertToPng);
	} catch (error) {
		return viewImageFailure(absolutePath, mediaType, bytes.length,
			`could not process ${displayPath(ctx, absolutePath)}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!ctx.model?.input?.includes("image")) {
		try {
			const described = await describeImageForTextModel(image, displayPath(ctx, absolutePath), signal, ctx);
			return {
				content: [{ type: "text", text: `Image description (${described.model}):\n${described.description}` }],
				usage: described.usage,
				details: { path: absolutePath, mediaType: image.mimeType, bytes: bytes.length, describedBy: described.model },
			};
		} catch (error) {
			return viewImageFailure(absolutePath, image.mimeType, bytes.length, error instanceof Error ? error.message : String(error));
		}
	}
	const fitted = await fitForConversation(image);
	return {
		content: [{ type: "text", text: `Viewed image: ${displayPath(ctx, absolutePath)}${fitted.note ? ` ${fitted.note}` : ""}` }, fitted.image],
		details: { path: absolutePath, mediaType: fitted.image.mimeType, bytes: bytes.length },
	};
}

type ImageRenderContext<TArgs> = { args?: TArgs; cwd: string; isError: boolean; lastComponent: unknown };

function renderViewImageResult(
	result: AgentToolResult<ViewImageDetails>, { expanded }: ToolRenderResultOptions,
	theme: Theme, context: ImageRenderContext<ViewImageParams>,
): Text {
	const raw = resultText(result), details = result.details;
	const path = typeof details?.path === "string" ? displayPathFromCwd(context.cwd, details.path) : (context.args?.path ?? "image");
	let display: string;
	if (context.isError || details.error) {
		display = raw.split("\n").map(line => theme.fg("error", line)).join("\n");
	} else {
		const lines = [theme.fg("success", "• Viewed Image"), theme.fg("muted", `  ${path}`)];
		if (expanded && details.describedBy && raw) lines.push(theme.fg("toolOutput", raw));
		display = lines.join("\n");
	}
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(display);
	return text;
}

function imageGenerationCallLabel(args: ImageGenerationParams): string {
	const operation = (args.referenced_image_paths?.length ?? 0) > 0 || args.num_last_images_to_include !== undefined
		? "Edit Image" : "Generate Image";
	const prompt = typeof args.prompt === "string" ? args.prompt.trim().split("\n", 1)[0] : "";
	return prompt ? `${operation}: ${prompt}` : operation;
}

function renderImageGenerationResult(
	result: AgentToolResult<ImageGenerationDetails>, { expanded }: ToolRenderResultOptions,
	theme: Theme, context: ImageRenderContext<ImageGenerationParams>,
): Text {
	const raw = resultText(result), details = result.details;
	let display: string;
	if (context.isError) {
		display = [theme.fg("error", "✗ Image generation failed"), theme.fg("error", raw)].filter(Boolean).join("\n");
	} else {
		const lines = [theme.fg("success", "• Generated Image:"),
			theme.fg("muted", `  ${displayPathFromCwd(context.cwd, details.path)}`)];
		if (expanded && details.revisedPrompt) lines.push(theme.fg("toolOutput", `Revised prompt: ${details.revisedPrompt}`));
		display = lines.join("\n");
	}
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(display);
	return text;
}

export function registerImageTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "view_image",
		label: "view_image",
		description: "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
		promptSnippet: "Inspect a local PNG/JPEG/GIF/WebP/BMP image",
		parameters: Type.Object({ path: Type.String({ description: "Path to a local image file." }) }, { additionalProperties: false }),
		prepareArguments: prepareViewImageArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeViewImage(params, ctx, signal);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold(`View Image: ${args.path}`)));
			return text;
		},
		renderResult(result, options, theme, context) {
			return renderViewImageResult(result as AgentToolResult<ViewImageDetails>, options, theme, context);
		},
	});
	pi.registerTool({
		name: "image_gen",
		label: "image_gen",
		// Loaded with tool_search when needed; it needs a signed-in ChatGPT or OpenAI account, checked when it runs.
		exposure: "deferred", namespace: { name: "images", description: "Generate or edit raster images." },
		description: "Generate an image from a prompt, or edit up to five images: local files (referenced_image_paths) or the most recent conversation images (num_last_images_to_include). Uses a signed-in ChatGPT or OpenAI account.",
		promptSnippet: "Generate or edit images",
		parameters: Type.Object({
			prompt: Type.String({ description: "Detailed generation prompt or precise editing instructions." }),
			model: Type.Union([Type.Literal(IMAGE_GENERATION_MODELS[0]), Type.Literal(IMAGE_GENERATION_MODELS[1])], {
				description: "Sunburst for precise edits; Flare for fast everyday generation.",
			}),
			referenced_image_paths: Type.Optional(Type.Array(
				Type.String({ description: "Local image path, absolute or relative to the session cwd." }),
				{ description: "Local images to edit, in prompt-reference order.", minItems: 1, maxItems: 5 },
			)),
			num_last_images_to_include: Type.Optional(Type.Integer({
				description: "Number of most recent conversation images to edit when a target has no local path.",
				minimum: 1, maximum: 5,
			})),
		}, { additionalProperties: false }),
		prepareArguments: prepareImageGenerationArguments,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			return executeImageGeneration(toolCallId, params, signal, ctx, { convertImage: convertToPng, withFileMutationQueue });
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold(imageGenerationCallLabel(args))));
			return text;
		},
		renderResult(result, options, theme, context) {
			return renderImageGenerationResult(result as AgentToolResult<ImageGenerationDetails>, options, theme, context);
		},
	});
}
