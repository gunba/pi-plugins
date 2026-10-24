import type { DocumentChanges, DocumentPreview } from "./documents.ts";

/** Computed changes to an Office file, attached to the result of the tool call that made them. */
export type DocumentChange = { path: string; kind: "xlsx" | "docx" | "pptx"; created?: boolean; summary: string; changes?: DocumentChanges; preview?: DocumentPreview };
export type ShownItem = {
	/** html: shown as a live page, its scripts run in a sandbox without network access. */
	path?: string; missing?: boolean; kind?: "image" | "office" | "text" | "html" | "file";
	/** Changes since the agent first touched the file in this conversation. */
	changes?: DocumentChanges; diff?: { text: string; added: number; removed: number; truncated: boolean };
	preview?: DocumentPreview; excerpt?: { firstLine: number; text: string; truncated: boolean };
	described?: { where: string; before?: string; after?: string }[];
	/** Changed cells the agent's own list did not mention. */
	unlisted?: { count: number; examples: string[] };
};
export type Shown = { title: string; note?: string; items: ShownItem[] };
