import { useEffect, useRef, useState } from "react";
import type { WorkerCommand } from "../shared/protocol.ts";
import { CHUNK_BYTES, FILE_COUNT, FILE_LIMIT, MESSAGE_FILE_LIMIT } from "../shared/attachments.ts";

export interface DraftFile {
	id: string; name: string; blob: Blob;
	uploaded?: { session: string; id: string };
}
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
	return database ??= new Promise((resolve, reject) => {
		const request = indexedDB.open("pi-desk-drafts", 1);
		request.onupgradeneeded = () => request.result.createObjectStore("attachments");
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => { database = undefined; reject(request.error); };
	});
}
async function change(key: string, update?: (files: DraftFile[]) => DraftFile[]): Promise<DraftFile[]> {
	const database = await db();
	return new Promise((resolve, reject) => {
		const transaction = database.transaction("attachments", update ? "readwrite" : "readonly");
		const store = transaction.objectStore("attachments"), request = store.get(key);
		let value: DraftFile[] = [], failure: unknown;
		request.onsuccess = () => {
			try {
				value = update ? update(request.result ?? []) : request.result ?? [];
				if (update) { if (value.length) store.put(value, key); else store.delete(key); }
			} catch (error) { failure = error; transaction.abort(); }
		};
		transaction.oncomplete = () => resolve(value);
		transaction.onabort = transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Could not save attachments on this device."));
	});
}
export async function draftAttachments(): Promise<Map<string, DraftFile[]>> {
	const database = await db();
	return new Promise((resolve, reject) => {
		const transaction = database.transaction("attachments", "readonly"), store = transaction.objectStore("attachments");
		const result = new Map<string, DraftFile[]>(), cursor = store.openCursor();
		cursor.onsuccess = () => {
			const value = cursor.result;
			if (!value) return;
			if (typeof value.key === "string" && Array.isArray(value.value) && value.value.length) result.set(value.key, value.value);
			value.continue();
		};
		transaction.oncomplete = () => resolve(result);
		transaction.onabort = transaction.onerror = () => reject(new Error("Cannot read saved attachments."));
	});
}
export async function copyDraftAttachments(source: string, target: string, commit: () => () => void): Promise<void> {
	if (source === target) throw new Error("Choose another conversation.");
	const database = await db();
	await new Promise<void>((resolve, reject) => {
		const transaction = database.transaction("attachments", "readwrite"), store = transaction.objectStore("attachments");
		const read = store.get(source), destination = store.get(target);
		let completed = 0, failure: unknown, rollback: (() => void) | undefined;
		const ready = () => {
			if (++completed !== 2) return;
			try {
				if (destination.result?.length) throw new Error("The current conversation already has attachments.");
				const files = (read.result ?? []) as DraftFile[];
				if (files.length > FILE_COUNT || files.some(file => !(file.blob instanceof Blob) || file.blob.size > FILE_LIMIT)
					|| files.reduce((sum, file) => sum + file.blob.size, 0) > MESSAGE_FILE_LIMIT) throw new Error("Saved attachments exceed the message limits.");
				rollback = commit();
				if (files.length) store.put(files.map(file => ({ id: crypto.randomUUID(), name: file.name, blob: file.blob })), target);
			} catch (error) { failure = error; transaction.abort(); }
		};
		read.onsuccess = destination.onsuccess = ready;
		transaction.oncomplete = () => resolve();
		transaction.onabort = transaction.onerror = () => {
			try { rollback?.(); } finally { reject(failure ?? new Error("Cannot copy saved attachments.")); }
		};
	});
	dispatchEvent(new CustomEvent("pi-desk:draft-changed", { detail: target }));
}
const encoded = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
	const reader = new FileReader();
	reader.onload = () => resolve(String(reader.result).split(",")[1]!);
	reader.onerror = () => reject(reader.error);
	reader.readAsDataURL(blob);
});

export function useAttachments(key: string, report: (text: string) => void) {
	const [stored, setStored] = useState<{ key: string; files: DraftFile[] }>();
	const [progress, setProgress] = useState("");
	const current = useRef(key); current.current = key;
	const files = stored?.key === key ? stored.files : [];
	const ready = stored?.key === key;
	useEffect(() => {
		let cancelled = false;
		const refresh = () => {
			void change(key).then(files => { if (!cancelled) setStored({ key, files }); })
				.catch(error => { if (!cancelled) report(String(error)); });
		};
		const changed = (event: Event) => { if ((event as CustomEvent).detail === key) refresh(); };
		refresh(); addEventListener("pi-desk:draft-changed", changed);
		return () => { cancelled = true; removeEventListener("pi-desk:draft-changed", changed); };
	}, [key]);
	const mutate = async (update: (files: DraftFile[]) => DraftFile[]) => {
		const files = await change(key, update);
		if (current.current === key) setStored({ key, files });
	};
	const add = (values: FileList | File[]) => {
		const incoming = Array.from(values).map(file => ({ id: crypto.randomUUID(), name: file.name, blob: file }));
		void mutate(previous => {
			const next = [...previous, ...incoming];
			if (next.length > FILE_COUNT) throw new Error("Attach up to eight files.");
			if (next.some(file => file.blob.size > FILE_LIMIT)) throw new Error("Each attachment must be at most 8 MiB.");
			if (next.reduce((sum, file) => sum + file.blob.size, 0) > MESSAGE_FILE_LIMIT) throw new Error("Attachments must total at most 32 MiB.");
			return next;
		}).catch(error => report(String(error)));
	};
	return {
		files, ready, progress, add,
		remove: (id: string) => { void mutate(files => files.filter(file => file.id !== id)).catch(error => report(String(error))); },
		clear: (ids: string[]) => mutate(files => files.filter(file => !ids.includes(file.id))),
		upload: async (sessionId: string, command: (value: WorkerCommand) => Promise<unknown>) => {
			const ids: string[] = [];
			try {
				for (const file of files) {
					let id = file.uploaded?.session === sessionId ? file.uploaded.id : undefined;
					if (!id) {
						const response = await command({ kind: "upload_begin", name: file.name, size: file.blob.size }) as { result: { id: string } };
						id = response.result.id;
						const uploaded = { session: sessionId, id };
						await mutate(files => files.map(item => item.id === file.id ? { ...item, uploaded } : item));
					}
					try {
						for (let offset = 0; offset < file.blob.size; offset += CHUNK_BYTES) {
							setProgress(`${file.name} · ${Math.round(offset / file.blob.size * 100)}%`);
							await command({ kind: "upload_chunk", id, offset, base64: await encoded(file.blob.slice(offset, offset + CHUNK_BYTES)) });
						}
						await command({ kind: "upload_finish", id });
					} catch (error) {
						// Keep uncertain network deliveries retryable; expired uploads need a fresh slot.
						if (/ENOENT|Attachment.*unavailable|Upload contents changed/.test(String(error))) {
							await mutate(files => files.map(item => item.id === file.id ? { ...item, uploaded: undefined } : item));
						}
						throw error;
					}
					ids.push(id);
				}
				return ids;
			} finally { setProgress(""); }
		},
	};
}

function FilePreview({ file }: { file: DraftFile }) {
	const [url, setUrl] = useState("");
	useEffect(() => {
		if (!/^image\/(png|jpeg|gif|webp)$/.test(file.blob.type)) return;
		const url = URL.createObjectURL(file.blob); setUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [file.blob]);
	return url ? <img src={url} alt="" /> : <span className="file-icon">▤</span>;
}
export function AttachmentList({ files, disabled, remove }: { files: DraftFile[]; disabled: boolean; remove: (id: string) => void }) {
	if (!files.length) return null;
	return <div className="attachments">{files.map(file => <div className="attachment" key={file.id}>
		<FilePreview file={file} />
		<div><strong title={file.name}>{file.name}</strong><small>{file.blob.size < 1024 * 1024
			? `${Math.ceil(file.blob.size / 1024)} KiB` : `${(file.blob.size / 1024 / 1024).toFixed(1)} MiB`}</small></div>
		<button type="button" disabled={disabled} aria-label={`Remove ${file.name}`} onClick={() => remove(file.id)}>×</button>
	</div>)}</div>;
}
