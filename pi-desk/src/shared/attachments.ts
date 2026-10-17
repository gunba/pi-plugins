export const FILE_LIMIT = 8 * 1024 * 1024;
export const MESSAGE_FILE_LIMIT = 32 * 1024 * 1024;
export const FILE_COUNT = 8;
export const CHUNK_BYTES = 192 * 1024;
export interface Attachment { id: string; name: string; size: number; mimeType: string }
export type UploadCommand =
	| { kind: "upload_begin"; name: string; size: number }
	| { kind: "upload_chunk"; id: string; offset: number; base64: string }
	/** sha256: hex digest of the whole file as the browser had it, checked against what the host wrote. */
	| { kind: "upload_finish"; id: string; sha256?: string }
	| { kind: "upload_discard"; id: string };
