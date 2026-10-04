import { api } from "./connection.ts";
import { DOT_FILE_BYTES, DOT_FILE_COUNT, type DotUpload, type DotDownload } from "../shared/dot.ts";

export async function stageDotFiles(files: File[], dot: string, computer: string | undefined, progress?: (file: DotUpload) => void): Promise<DotUpload[]> {
	if (!files.length || files.length > DOT_FILE_COUNT) throw Error("Choose up to eight files.");
	if (files.some(file => !file.size || file.size > DOT_FILE_BYTES)) throw Error("Dot attachments must be 20 MB or smaller.");
	const results = await Promise.allSettled(files.map(async file => {
		let staged = await api<DotUpload>("/dot/uploads", { id: crypto.randomUUID(), dot, name: file.name, mime: file.type || "application/octet-stream", size: file.size }, computer);
		progress?.(staged);
		for (let offset = staged.received; offset < file.size;) {
			const bytes = new Uint8Array(await file.slice(offset, offset + 256 * 1024).arrayBuffer());
			let binary = ""; for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
			staged = await api<DotUpload>(`/dot/uploads/${staged.id}`, { offset, data: btoa(binary) }, computer);
			offset = staged.received; progress?.(staged);
		}
		return staged;
	}));
	const failure = results.find(result => result.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
	return results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
}

export async function saveDotDownload(file: DotDownload, computer?: string, surface?: string): Promise<void> {
	const query = surface ? `&surface=${encodeURIComponent(surface)}` : "";
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	for (let offset = 0; offset < file.size;) {
		const chunk = await api<{ data: string; next: number; size: number }>(`/dot/downloads/${file.id}?offset=${offset}${query}`, undefined, computer);
		const bytes = Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0));
		if (chunk.size !== file.size || chunk.next !== offset + bytes.length || !bytes.length || chunk.next > file.size) throw Error("Native download changed. Open it again.");
		chunks.push(bytes); offset = chunk.next;
	}
	const blob = new Blob(chunks, { type: file.mime });
	const url = URL.createObjectURL(blob), anchor = document.createElement("a");
	anchor.href = url; anchor.download = file.name; anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
	await api(`/dot/downloads/${file.id}/release${surface ? `?surface=${encodeURIComponent(surface)}` : ""}`, {}, computer);
}
