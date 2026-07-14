import {
	MAX_LOCAL_IMAGE_BYTES,
	decodedBase64ByteLength,
} from "./image-limits.ts";

type UnknownRecord = Record<string, unknown>;

export type ImageConverter = (
	data: string,
	mimeType: string,
) => Promise<{ data: string; mimeType: string } | null>;

export type NativeImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};

const NATIVE_IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/bmp",
]);

const PROVIDER_IMAGE_MIME_TYPES = new Set(
	[...NATIVE_IMAGE_MIME_TYPES].filter((mimeType) => mimeType !== "image/bmp"),
);
export const MAX_PROVIDER_IMAGE_CONVERSIONS = 4;

function createAsyncLimiter(maxConcurrent: number) {
	let active = 0;
	const pending: Array<() => void> = [];
	const acquire = async () => {
		if (active < maxConcurrent) {
			active += 1;
			return;
		}
		await new Promise<void>((resolve) => pending.push(resolve));
		active += 1;
	};
	const release = () => {
		active -= 1;
		pending.shift()?.();
	};
	return async <T>(operation: () => Promise<T>): Promise<T> => {
		await acquire();
		try {
			return await operation();
		} finally {
			release();
		}
	};
}

function isRecord(value: unknown): value is UnknownRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function nativeMimeType(value: unknown): string | undefined {
	return typeof value === "string" && NATIVE_IMAGE_MIME_TYPES.has(value)
		? value
		: undefined;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_END = [
	0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

function bytesMatch(
	bytes: Uint8Array,
	offset: number,
	expected: number[],
): boolean {
	return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
	return String.fromCharCode(...bytes.subarray(start, end));
}

function decodeBase64(data: string): Uint8Array {
	try {
		return Uint8Array.from(globalThis.atob(data), (character) =>
			character.charCodeAt(0),
		);
	} catch {
		return new Uint8Array();
	}
}

const IMAGE_SIGNATURES: Array<{
	mimeType: string;
	matches: (bytes: Uint8Array) => boolean;
}> = [
	{
		mimeType: "image/png",
		matches: (bytes) =>
			bytes.length >= 24 &&
			bytesMatch(bytes, 0, PNG_SIGNATURE) &&
			bytesMatch(bytes, bytes.length - PNG_END.length, PNG_END),
	},
	{
		mimeType: "image/jpeg",
		matches: (bytes) =>
			bytes.length >= 4 &&
			bytes[0] === 0xff &&
			bytes[1] === 0xd8 &&
			bytes.at(-2) === 0xff &&
			bytes.at(-1) === 0xd9,
	},
	{
		mimeType: "image/gif",
		matches: (bytes) =>
			bytes.length >= 14 &&
			["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6)) &&
			bytes.at(-1) === 0x3b,
	},
	{
		mimeType: "image/webp",
		matches: (bytes) =>
			bytes.length >= 12 &&
			ascii(bytes, 0, 4) === "RIFF" &&
			ascii(bytes, 8, 12) === "WEBP",
	},
	{
		mimeType: "image/bmp",
		matches: (bytes) =>
			bytes.length >= 14 && bytes[0] === 0x42 && bytes[1] === 0x4d,
	},
];

function inferMimeType(data: string): string | undefined {
	if (decodedBase64ByteLength(data) > MAX_LOCAL_IMAGE_BYTES) return undefined;
	const bytes = decodeBase64(data);
	return IMAGE_SIGNATURES.find(({ matches }) => matches(bytes))?.mimeType;
}

function imagePayload(block: UnknownRecord): {
	data?: string;
	mimeType?: string;
} {
	const source = isRecord(block.source) ? block.source : undefined;
	const data = firstString(block.data, source?.data);
	const mimeType = nativeMimeType(
		firstString(
			block.mimeType,
			block.mediaType,
			source?.mimeType,
			source?.mediaType,
			source?.media_type,
		),
	);
	return { data, mimeType };
}

export function createImageContent(
	data: string,
	mimeType: string,
): NativeImageContent {
	if (!data) throw new Error("image data cannot be empty");
	if (decodedBase64ByteLength(data) > MAX_LOCAL_IMAGE_BYTES) {
		throw new Error(`image data is larger than ${MAX_LOCAL_IMAGE_BYTES} bytes`);
	}
	if (!nativeMimeType(mimeType)) {
		throw new Error(`unsupported image MIME type: ${mimeType}`);
	}
	return { type: "image", data, mimeType };
}

export async function prepareNativeImageContent(
	input: { data: string; mimeType?: string },
	convertImage: ImageConverter,
): Promise<NativeImageContent> {
	if (decodedBase64ByteLength(input.data) > MAX_LOCAL_IMAGE_BYTES) {
		throw new Error(`image data is larger than ${MAX_LOCAL_IMAGE_BYTES} bytes`);
	}
	const declaredMimeType = nativeMimeType(input.mimeType);
	const mimeType = inferMimeType(input.data);
	if (!mimeType) throw new Error("unsupported or invalid image data");
	if (declaredMimeType && declaredMimeType !== mimeType) {
		throw new Error(
			`image MIME type ${declaredMimeType} does not match ${mimeType} data`,
		);
	}
	if (PROVIDER_IMAGE_MIME_TYPES.has(mimeType)) {
		return createImageContent(input.data, mimeType);
	}

	const converted = await convertImage(input.data, mimeType);
	if (
		converted &&
		decodedBase64ByteLength(converted.data) > MAX_LOCAL_IMAGE_BYTES
	) {
		throw new Error(
			`converted image data is larger than ${MAX_LOCAL_IMAGE_BYTES} bytes`,
		);
	}
	const convertedMimeType = converted
		? inferMimeType(converted.data)
		: undefined;
	if (
		!converted ||
		!convertedMimeType ||
		converted.mimeType !== convertedMimeType ||
		!PROVIDER_IMAGE_MIME_TYPES.has(convertedMimeType)
	) {
		throw new Error(
			`could not convert ${mimeType} to a supported image format`,
		);
	}
	return createImageContent(converted.data, convertedMimeType);
}

export function normalizeLegacyImageBlock(block: unknown): unknown {
	if (!isRecord(block) || block.type !== "image") return block;

	const { data, mimeType: declaredMimeType } = imagePayload(block);
	if (data && declaredMimeType) {
		const inferredMimeType = inferMimeType(data);
		if (!inferredMimeType) {
			return {
				type: "text",
				text: "[Invalid image content omitted: unsupported or invalid image data]",
			};
		}
		if (declaredMimeType !== inferredMimeType) {
			return {
				type: "text",
				text: `[Invalid image content omitted: image MIME type ${declaredMimeType} does not match ${inferredMimeType} data]`,
			};
		}
		if (block.data === data && block.mimeType === declaredMimeType) {
			return block;
		}
		return createImageContent(data, declaredMimeType);
	}

	const inferredMimeType = data ? inferMimeType(data) : undefined;
	if (data && inferredMimeType)
		return createImageContent(data, inferredMimeType);

	return {
		type: "text",
		text: "[Invalid image content omitted: missing data or supported MIME type]",
	};
}

export function normalizeLegacyImageMessages<T>(messages: T[]): T[] {
	let messagesChanged = false;
	const normalized = messages.map((message) => {
		if (!isRecord(message) || !Array.isArray(message.content)) return message;

		let contentChanged = false;
		const content = message.content.map((block) => {
			const next = normalizeLegacyImageBlock(block);
			if (next !== block) contentChanged = true;
			return next;
		});
		if (!contentChanged) return message;

		messagesChanged = true;
		return { ...message, content } as T;
	});

	return messagesChanged ? normalized : messages;
}

export async function normalizeProviderImageMessages<T>(
	messages: T[],
	convertImage: ImageConverter,
): Promise<T[]> {
	const legacyNormalized = normalizeLegacyImageMessages(messages);
	let messagesChanged = legacyNormalized !== messages;
	const limitConversion = createAsyncLimiter(MAX_PROVIDER_IMAGE_CONVERSIONS);
	const normalized = await Promise.all(
		legacyNormalized.map(async (message) => {
			if (!isRecord(message) || !Array.isArray(message.content)) return message;

			let contentChanged = false;
			const content = await Promise.all(
				message.content.map(async (block) => {
					if (
						!isRecord(block) ||
						block.type !== "image" ||
						typeof block.data !== "string" ||
						typeof block.mimeType !== "string"
					) {
						return block;
					}
					if (PROVIDER_IMAGE_MIME_TYPES.has(block.mimeType)) return block;
					const data = block.data;
					const mimeType = block.mimeType;

					try {
						const prepared = await limitConversion(() =>
							prepareNativeImageContent({ data, mimeType }, convertImage),
						);
						if (
							prepared.data === block.data &&
							prepared.mimeType === block.mimeType
						) {
							return block;
						}
						contentChanged = true;
						return prepared;
					} catch (error) {
						contentChanged = true;
						const message =
							error instanceof Error ? error.message : String(error);
						return {
							type: "text",
							text: `[Image content omitted: ${message}]`,
						};
					}
				}),
			);
			if (!contentChanged) return message;

			messagesChanged = true;
			return { ...message, content } as T;
		}),
	);

	return messagesChanged ? normalized : messages;
}
