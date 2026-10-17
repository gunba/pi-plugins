import { useEffect, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import type { ChatBlock } from "../shared/protocol.ts";
import type { FileInfo, FileReference } from "../shared/files.ts";
import type { CellChange, DocumentChanges, DocumentPreview, ParagraphOp } from "../../../pi-show/extensions/documents.ts";
import type { ShownItem } from "../../../pi-show/extensions/types.ts";
import { diffSequences } from "../../../pi-show/extensions/sequence-diff.ts";
import { FileLink, fileBlob } from "./file-view.tsx";
import { AssetLink } from "./assets.tsx";
import { CopyButton } from "./transcript-parts.tsx";
import { api } from "./connection.ts";
import { useReferenceQuery } from "./reference-origin.tsx";
import { Icon } from "./icons.tsx";

type DiffBlock = Extract<ChatBlock, { type: "diff" }>;
type DocumentBlock = Extract<ChatBlock, { type: "document" }>;
type ShownBlock = Extract<ChatBlock, { type: "shown" }>;

/** Put a quote of what an agent showed into the composer, so Jordan can reply to it. */
export function quote(text: string): void {
	window.dispatchEvent(new CustomEvent("pi-desk:quote", { detail: text.split("\n").map(line => `> ${line}`).join("\n") + "\n\n" }));
}
const name = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
function Reply({ text, label = "Reply" }: { text: () => string; label?: string }) {
	return <button type="button" className="change-reply" title="Quote this in your reply" onClick={() => quote(text())}><Icon name="chat" />{label}</button>;
}
/** Show the first `limit` rows, with a control for the rest. */
function Capped<T>({ items, limit, render, unit }: { items: T[]; limit: number; render: (item: T, index: number) => ReactNode; unit: string }) {
	const [all, setAll] = useState(false), shown = all ? items : items.slice(0, limit);
	return <>{shown.map(render)}{items.length > limit && <button type="button" className="change-more" onClick={() => setAll(!all)}>
		{all ? "Show less" : `Show ${items.length - limit} more ${unit}${items.length - limit === 1 ? "" : "s"}`}</button>}</>;
}
function Stats({ added, removed }: { added?: number; removed?: number }) {
	return <span className="change-stats">{!!added && <span className="change-added">+{added}</span>}{!!removed && <span className="change-removed">−{removed}</span>}</span>;
}
function FileName({ session, path, file }: { session: string; path: string; file?: FileReference | null }) {
	return file ? <FileLink session={session} file={file}>{name(path)}</FileLink> : <strong title={path}>{name(path)}</strong>;
}

function DiffLines({ text, limit = 14 }: { text: string; limit?: number }) {
	const lines = text.split("\n");
	return <pre className="change-diff"><Capped items={lines} limit={limit} unit="line" render={(line, index) =>
		<span key={index} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : line.trim() === "..." ? "diff-gap" : "diff-context"}>{line}</span>} /></pre>;
}
export const diffStats = (block: DiffBlock) => {
	const lines = block.text.split("\n");
	return { added: block.added ?? lines.filter(line => /^\+\s*\d/.test(line)).length, removed: block.removed ?? lines.filter(line => /^-\s*\d/.test(line)).length };
};

/** A text file change, visible in the conversation rather than inside the tool call. */
export function ChangeCard({ block, session }: { block: DiffBlock; session: string }) {
	const { added, removed } = diffStats(block);
	return <section className="change-card">
		<header><span className="change-kind">{block.action === "added" ? "New" : block.action === "deleted" ? "Deleted" : block.action === "moved" ? "Moved" : "Edited"}</span>
			<FileName session={session} path={block.movePath ?? block.path} file={block.file} /><Stats added={added} removed={removed} />
			<span className="change-actions"><CopyButton text={() => block.text} label="Copy diff" />
				<Reply text={() => `${block.path}\n${block.text.split("\n").filter(line => /^[+-]/.test(line)).slice(0, 12).join("\n")}`} /></span></header>
		<DiffLines text={block.text} />
		{block.truncated && <p className="muted">Diff preview limited to 12,000 characters.</p>}
		{block.full && <AssetLink session={session} asset={block.full} />}
	</section>;
}

/** Old and new paragraph text with the changed words marked. */
function WordDiff({ before, after }: { before: string; after: string }) {
	const a = before.split(/(\s+)/), b = after.split(/(\s+)/), ops = diffSequences(a, b, undefined, 400);
	if (!ops) return <><del>{before}</del> <ins>{after}</ins></>;
	return <>{ops.map((op, index) => op.op === "=" ? <span key={index}>{b[op.b!]}</span> : op.op === "-" ? <del key={index}>{a[op.a!]}</del> : <ins key={index}>{b[op.b!]}</ins>)}</>;
}
/** Whether two paragraphs share at least a third of their words. */
function similar(a: string, b: string): boolean {
	const words = (text: string) => new Set(text.toLowerCase().split(/\W+/).filter(Boolean)), x = words(a), y = words(b);
	let shared = 0;
	for (const word of x) if (y.has(word)) shared++;
	return shared / Math.max(1, Math.min(x.size, y.size)) >= 1 / 3;
}
function Paragraphs({ ops, where, limit = 12 }: { ops: ParagraphOp[]; where: string; limit?: number }) {
	// Within a run of changes, the nth removed and nth added paragraphs are a rewrite when they share enough words:
	// show it once, with the words that changed.
	const rows: ({ kind: "=" | "-" | "+"; text: string } | { kind: "~"; before: string; after: string } | { kind: "gap"; count: number })[] = [];
	for (let index = 0; index < ops.length;) {
		const op = ops[index]!;
		if (op.op === "gap" || op.op === "=") { rows.push(op.op === "gap" ? { kind: "gap", count: op.count } : { kind: "=", text: op.text }); index++; continue; }
		const removed: string[] = [], added: string[] = [];
		while (index < ops.length && (ops[index]!.op === "-" || ops[index]!.op === "+")) {
			const change = ops[index++] as { op: "-" | "+"; text: string };
			(change.op === "-" ? removed : added).push(change.text);
		}
		for (let at = 0; at < Math.max(removed.length, added.length); at++) {
			const before = removed[at], after = added[at];
			if (before !== undefined && after !== undefined && similar(before, after)) rows.push({ kind: "~", before, after });
			else { if (before !== undefined) rows.push({ kind: "-", text: before }); if (after !== undefined) rows.push({ kind: "+", text: after }); }
		}
	}
	return <div className="change-paragraphs"><Capped items={rows} limit={limit} unit="paragraph" render={(row, index) =>
		row.kind === "gap" ? <p key={index} className="change-gap">… {row.count} unchanged paragraph{row.count === 1 ? "" : "s"}</p>
		: <p key={index} className={`change-paragraph change-${row.kind === "~" ? "edit" : row.kind === "+" ? "add" : row.kind === "-" ? "remove" : "same"}`}>
			{row.kind === "~" ? <WordDiff before={row.before} after={row.after} /> : row.kind === "-" ? <del>{row.text}</del> : row.kind === "+" ? <ins>{row.text}</ins> : row.text}
			{row.kind !== "=" && <Reply label="" text={() => `${where}\n${row.kind === "~" ? `${row.before}\n→ ${row.after}` : row.text}`} />}
		</p>} /></div>;
}
function CellTable({ cells, where }: { cells: CellChange[]; where: string }) {
	return <table className="change-cells"><thead><tr><th>Cell</th><th>Before</th><th>After</th><th /></tr></thead>
		<tbody><Capped items={cells} limit={12} unit="cell" render={(cell, index) => <tr key={index}>
			<td><code>{cell.sheet}!{cell.cell}</code></td>
			<td>{cell.before !== undefined ? <del>{cell.before}</del> : <span className="muted">empty</span>}{cell.formulaBefore && <code className="change-formula">={cell.formulaBefore}</code>}</td>
			<td>{cell.after !== undefined ? <ins>{cell.after}</ins> : <span className="muted">empty</span>}{cell.formulaAfter && <code className="change-formula">={cell.formulaAfter}</code>}</td>
			<td><Reply label="" text={() => `${where} ${cell.sheet}!${cell.cell}: ${cell.before ?? "empty"} → ${cell.after ?? "empty"}`} /></td>
		</tr>} /></tbody></table>;
}
export function DocumentChangesView({ changes, where }: { changes: DocumentChanges; where: string }) {
	if (changes.kind === "xlsx") return <>
		<p className="change-source">Read from the file by Desk</p>
		{changes.sheetsAdded.length > 0 && <p className="change-note">Sheets added: {changes.sheetsAdded.join(", ")}</p>}
		{changes.sheetsRemoved.length > 0 && <p className="change-note">Sheets removed: {changes.sheetsRemoved.join(", ")}</p>}
		{changes.cells.length > 0 && <CellTable cells={changes.cells} where={where} />}
		{changes.total > changes.cells.length && <p className="muted">{changes.total - changes.cells.length} more changed cells not listed.</p>}
	</>;
	if (changes.kind === "docx") return <><Paragraphs ops={changes.paragraphs} where={where} />{changes.truncated && <p className="muted">More changes not listed.</p>}</>;
	return <>{changes.slides.map(slide => <div key={slide.slide} className="change-slide"><h4>Slide {slide.slide}<small>{slide.status}</small></h4>
		<Paragraphs ops={slide.paragraphs} where={`${where}, slide ${slide.slide}`} limit={8} /></div>)}</>;
}
export function PreviewView({ preview }: { preview: DocumentPreview }) {
	if (preview.kind === "xlsx") {
		const columns = preview.rows[0]?.map((_, index) => columnName(preview.firstColumn + index)) ?? [];
		return <div className="sheet-preview"><p className="change-note">{preview.sheet}{preview.sheets.length > 1 && <small> · {preview.sheets.length} sheets</small>}</p>
			<div className="sheet-scroll"><table><thead><tr><th />{columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
				<tbody>{preview.rows.map((row, index) => <tr key={index}><th>{preview.firstRow + index}</th>
					{row.map((cell, column) => <td key={column} title={cell.formula ? `=${cell.formula}` : undefined} className={cell.formula ? "formula" : /^-?[\d.,]+%?$/.test(cell.value) ? "number" : undefined}>{cell.value}</td>)}</tr>)}</tbody></table></div>
			{preview.truncated && <p className="muted">Part of the sheet.</p>}</div>;
	}
	if (preview.kind === "docx") return <div className="document-preview">{preview.paragraphs.map((text, index) => <p key={index}>{text}</p>)}{preview.truncated && <p className="muted">…</p>}</div>;
	return <div className="document-preview">{preview.slides.map(slide => <div key={slide.slide} className="change-slide"><h4>Slide {slide.slide}</h4>{slide.paragraphs.map((text, index) => <p key={index}>{text}</p>)}</div>)}</div>;
}
function columnName(index: number): string {
	let label = "";
	for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(65 + (value - 1) % 26) + label;
	return label;
}

const KIND_ICON: Record<string, string> = { xlsx: "layers", docx: "edit", pptx: "preview" };
/** Changes to a spreadsheet, document or deck that Desk computed from the file itself. */
export function DocumentCard({ block, session }: { block: DocumentBlock; session: string }) {
	const { change } = block;
	return <section className="change-card document-card">
		<header><span className="change-kind"><Icon name={KIND_ICON[change.kind] ?? "edit"} />{change.created ? "New" : "Changed"}</span>
			<FileName session={session} path={change.path} file={block.file} /><span className="change-summary">{change.summary}</span>
			<span className="change-actions"><Reply text={() => `${name(change.path)}: ${change.summary}`} /></span></header>
		{change.changes && <DocumentChangesView changes={change.changes} where={name(change.path)} />}
		{change.preview && <PreviewView preview={change.preview} />}
	</section>;
}

/** An image file shown inline, loaded from the agent's computer. */
function InlineImage({ session, file }: { session: string; file: FileReference }) {
	const origin = useReferenceQuery();
	const [url, setUrl] = useState(""), [error, setError] = useState("");
	useEffect(() => {
		const controller = new AbortController();
		let created = "";
		void (async () => {
			try {
				const info = await api<FileInfo>(`/sessions/${session}/files/${file.id}?${origin}`);
				if (info.kind !== "image") throw new Error("Not an image.");
				const blob = await fileBlob(session, info, origin, controller.signal, () => {});
				created = URL.createObjectURL(blob.slice(0, blob.size, info.mimeType)); setUrl(created);
			} catch (error) { if (!controller.signal.aborted) setError(String(error)); }
		})();
		return () => { controller.abort(); if (created) URL.revokeObjectURL(created); };
	}, [session, file.id, origin]);
	return url ? <img className="shown-image" src={url} alt={file.name} /> : <p className="muted">{error || "Loading image…"}</p>;
}

function ShownEntry({ item, file, session, title }: { item: ShownItem; file: FileReference | null; session: string; title: string }) {
	const where = item.path ? name(item.path) : title;
	return <div className="shown-item">
		{item.path && <div className="shown-item-heading"><FileName session={session} path={item.path} file={file} />
			{item.missing && <span className="error-text">not found</span>}
			{item.changes && <span className="change-summary">{item.changes.summary}</span>}
			{item.diff && <Stats added={item.diff.added} removed={item.diff.removed} />}</div>}
		{item.unlisted && <p className="shown-warning" role="note"><Icon name="warning" />Desk found {item.unlisted.count} changed cell{item.unlisted.count === 1 ? "" : "s"} the agent did not mention: {item.unlisted.examples.join(", ")}{item.unlisted.count > item.unlisted.examples.length ? ", …" : ""}</p>}
		{item.kind === "image" && file && <InlineImage session={session} file={file} />}
		{item.changes && <DocumentChangesView changes={item.changes} where={where} />}
		{item.diff && <DiffLines text={item.diff.text} />}
		{item.preview && <PreviewView preview={item.preview} />}
		{item.excerpt && <pre className="change-diff shown-excerpt">{item.excerpt.text.split("\n").map((line, index) => <span key={index} className="diff-context">{String(item.excerpt!.firstLine + index).padStart(4)} {line}</span>)}</pre>}
		{item.described && <p className="change-source">Described by the agent</p>}
		{item.described && <ul className="shown-described">{item.described.map((change, index) => <li key={index}>
			<code>{change.where}</code>{change.before !== undefined && <del>{change.before}</del>}{change.before !== undefined && change.after !== undefined && <span aria-hidden="true">→</span>}{change.after !== undefined && <ins>{change.after}</ins>}
			<Reply label="" text={() => `${where} ${change.where}: ${change.before ?? ""}${change.after !== undefined ? ` → ${change.after}` : ""}`} />
		</li>)}</ul>}
	</div>;
}
/** Work an agent chose to show Jordan, drawn as a card in the conversation. */
export function ShownCard({ block, session, time }: { block: ShownBlock; session: string; time?: ReactNode }) {
	const { shown } = block;
	return <section className="shown-card">
		<header><span className="shown-badge"><Icon name="preview" />Shown</span><strong>{shown.title}</strong>{time}
			<span className="change-actions"><Reply text={() => shown.title} /></span></header>
		{shown.note && <div className="markdown shown-note"><Markdown>{shown.note}</Markdown></div>}
		{shown.items.map((item, index) => <ShownEntry key={index} item={item} file={block.files[index] ?? null} session={session} title={shown.title} />)}
	</section>;
}
