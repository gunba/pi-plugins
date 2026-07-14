import { open } from "node:fs/promises";

export const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_API_RESPONSE_BYTES = 32 * 1024 * 1024;

export async function readLocalImageFile(
	path: string,
	label: string,
	maxBytes = MAX_LOCAL_IMAGE_BYTES,
): Promise<Buffer> {
	const file = await open(path, "r");
	try {
		const stats = await file.stat();
		if (!stats.isFile()) throw new Error(`${label} is not a regular file`);
		if (stats.size > maxBytes) {
			throw new Error(`${label} is larger than ${maxBytes} bytes`);
		}
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		while (totalBytes <= maxBytes) {
			const remaining = maxBytes + 1 - totalBytes;
			const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
			const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
			totalBytes += bytesRead;
		}
		if (totalBytes > maxBytes) {
			throw new Error(`${label} is larger than ${maxBytes} bytes`);
		}
		return Buffer.concat(chunks, totalBytes);
	} finally {
		await file.close();
	}
}

export function decodedBase64ByteLength(data: string): number {
	const normalized = data.trim();
	if (!normalized) return 0;
	let padding = 0;
	if (normalized.endsWith("==")) padding = 2;
	else if (normalized.endsWith("=")) padding = 1;
	return Math.floor((normalized.length * 3) / 4) - padding;
}

export async function readResponseTextWithinLimit(
	response: Response,
	maxBytes = MAX_IMAGE_API_RESPONSE_BYTES,
): Promise<string> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (Number.isFinite(parsed) && parsed > maxBytes) {
			await response.body?.cancel().catch(() => {});
			throw new Error(
				`image generation response is larger than ${maxBytes} bytes`,
			);
		}
	}

	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytesRead = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytesRead += value.byteLength;
			if (bytesRead > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new Error(
					`image generation response is larger than ${maxBytes} bytes`,
				);
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return text;
	} finally {
		reader.releaseLock();
	}
}
