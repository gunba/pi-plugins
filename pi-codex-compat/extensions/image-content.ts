import { crc32 } from "node:zlib";
import {
	MAX_LOCAL_IMAGE_BYTES,
	decodedBase64ByteLength,
} from "./image-limits.ts";

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
function nativeMimeType(value: unknown): string | undefined {
	return typeof value === "string" && NATIVE_IMAGE_MIME_TYPES.has(value)
		? value
		: undefined;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_END = [
	0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

function validPng(bytes: Uint8Array): boolean {
	if (bytes.length < 8 + 25 + PNG_END.length ||
		!bytesMatch(bytes, 0, PNG_SIGNATURE)) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = PNG_SIGNATURE.length;
	let sawImageData = false;
	let first = true;
	while (offset + 12 <= bytes.length) {
		const length = view.getUint32(offset);
		const end = offset + 12 + length;
		if (end > bytes.length) return false;
		const type = ascii(bytes, offset + 4, offset + 8);
		if (first && (type !== "IHDR" || length !== 13)) return false;
		if (type === "IDAT") sawImageData = true;
		if (view.getUint32(end - 4) !== crc32(bytes.subarray(offset + 4, end - 4)))
			return false;
		if (type === "IEND") return sawImageData && length === 0 && end === bytes.length;
		offset = end;
		first = false;
	}
	return false;
}

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
	// Buffer's decoder is permissive; retain atob's alphabet/padding rules.
	const compact = data.replace(/[\t\n\f\r ]/g, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) ||
		compact.length % 4 === 1 ||
		(compact.includes("=") && compact.length % 4 !== 0))
		return new Uint8Array();
	return Buffer.from(compact, "base64");
}

const IMAGE_SIGNATURES: Array<{
	mimeType: string;
	matches: (bytes: Uint8Array) => boolean;
}> = [
	{
		mimeType: "image/png",
		matches: validPng,
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
