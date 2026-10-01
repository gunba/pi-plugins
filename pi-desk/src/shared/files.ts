export const FILE_CHUNK_BYTES = 256 * 1024;
export const FILE_DOWNLOAD_LIMIT = 128 * 1024 * 1024;
export const FILE_IMAGE_LIMIT = 16 * 1024 * 1024;
export interface FileReference { id: string; name: string; line?: number }
export interface FileInfo extends FileReference {
	path: string; size: number; version: string; kind: "text" | "image" | "binary"; mimeType: string;
}
export interface FileTextPage { text: string; offset: number; next: number | null; line?: number }
export interface FileChunk { base64: string; offset: number; next: number | null }
export type FileCommand = { kind: "file"; id: string } & (
	| { operation: "info" }
	| { operation: "text"; version: string; offset?: number; line?: number }
	| { operation: "chunk"; version: string; offset: number }
	| { operation: "open"; version: string }
	| { operation: "reveal"; version: string }
);
