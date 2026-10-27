import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import type { ChatBlock, ChatMessage } from "../shared/protocol.ts";
import type { FileInfo, FileReference } from "../shared/files.ts";
import type { CellChange, DocumentChanges, DocumentPreview, ParagraphOp } from "../../../pi-show/extensions/documents.ts";
import type { ShownItem } from "../../../pi-show/extensions/types.ts";
import { diffSequences } from "../../../pi-show/extensions/sequence-diff.ts";
import { FileLink, fileBlob } from "./file-view.tsx";
import { AssetLink } from "./assets.tsx";
import { CopyButton } from "./transcript-parts.tsx";
import { SurfaceFrame } from "./surfaces.tsx";
import { acquireAsset, api } from "./connection.ts";
import { ReferenceContext, useReferenceQuery } from "./reference-origin.tsx";
import { Icon } from "./icons.tsx";
import { BriefView, type Brief } from "./brief.tsx";
import { markdownPlugins } from "./markdown-links.ts";
import { shownUrl } from "../../../pi-show/extensions/links.ts";

type DiffBlock = Extract<ChatBlock, { type: "diff" }>;
type DocumentBlock = Extract<ChatBlock, { type: "document" }>;
type ShownBlock = Extract<ChatBlock, { type: "shown" }>;
type ImageBlock = Extract<ChatBlock, { type: "image" }>;

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

export const diffStats = (block: DiffBlock) => {
	const rows = diffRows(block.text);
	return { added: block.added ?? rows.filter(row => row.kind === "add").length, removed: block.removed ?? rows.filter(row => row.kind === "remove").length };
};

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


/* ── Work items: changes and shown work, listed in the side pane ─────────────────────────────────────────── */

/** `message` and `source` locate the files it links to: the transcript message, and a sub-agent transcript if any. */
/** title: for an image, the file it came from. */
/** "What do I need to know?": written on request, kept in the side pane while the conversation goes on. */
export type BriefBlock = { type: "brief"; brief: Brief; working?: boolean; rewrite?: () => void };
export type WorkItem = { id: string; at: number; message: string; source?: string; title?: string; block: DiffBlock | DocumentBlock | ShownBlock | ImageBlock | BriefBlock };
/** Changes, shown work and images returned by tools, in the loaded part of a conversation, oldest first. */
export function workItems(messages: readonly ChatMessage[]): WorkItem[] {
	return messages.flatMap(message => message.blocks.flatMap((block, index): WorkItem[] => {
		const item = { id: `${message.id}:${index}`, at: message.timestamp, message: message.id };
		if (block?.type === "diff" || block?.type === "document" || block?.type === "shown") return [{ ...item, block }];
		// A file block names its image; otherwise the result may be a screenshot, a read, or a generated picture.
		if (block?.type === "image" && message.role === "tool") {
			const file = message.blocks.find(other => other?.type === "file");
			return [{ ...item, block, title: file?.type === "file" ? file.file.name : "Image" }];
		}
		return [];
	}));
}
/** A link in an agent reply or shown result: a local file Desk can open, or a web page. */
export type LinkItem = { key: string; at: number; message: string; label: string; url?: string; file?: FileReference };
const LINK = /\[([^\]\n]{1,200})\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()\]]*[^\s<>()\].,;:!?'"*_`])/g;
/** Links in loaded replies and shown results, each once at its latest mention, oldest first. */
export function messageLinks(messages: readonly ChatMessage[]): LinkItem[] {
	const found = new Map<string, LinkItem>();
	for (const message of messages) {
		const add = (target: string, label?: string) => {
			// The host resolved local file links; other destinations must be credential-free web addresses.
			const file = message.links?.find(link => link.target === target)?.file, url = shownUrl(target);
			const item: LinkItem | undefined = file ? { key: `file:${file.id}`, at: message.timestamp, message: message.id, label: label || file.name, file }
				: url ? { key: url, at: message.timestamp, message: message.id, label: label && label !== target ? label : url.replace(/^https?:\/\/(www\.)?/i, ""), url } : undefined;
			if (item) { found.delete(item.key); found.set(item.key, item); }
		};
		for (const block of message.blocks) {
			const text = block?.type === "shown" ? block.shown.note : block?.type === "text" && message.role === "assistant" ? block.text : undefined;
			for (const match of text?.matchAll(LINK) ?? []) add(match[2] ?? match[3]!, match[1]?.trim());
			if (block?.type === "shown") for (const item of block.shown.items) if (item.url) add(item.url, item.label);
		}
	}
	return [...found.values()];
}

/** Opens an item: in the side pane when there is room, otherwise in the expanded view. */
export const WorkFocus = createContext<(item: WorkItem) => void>(() => undefined);
const itemTitle = (item: WorkItem) => item.block.type === "brief" ? "What do I need to know?" : item.block.type === "image" ? item.title ?? "Image" : item.block.type === "diff" ? name(item.block.movePath ?? item.block.path)
	: item.block.type === "document" ? name(item.block.change.path) : item.block.shown.title;
const itemKind = (item: WorkItem) => item.block.type === "brief" ? "Brief" : item.block.type === "image" ? "Viewed" : item.block.type === "shown" ? "Shown" : item.block.type === "document" ? item.block.change.created ? "New" : "Changed"
	: item.block.meanwhile ? "Meanwhile" : item.block.action === "added" ? "New" : item.block.action === "deleted" ? "Deleted" : item.block.action === "moved" ? "Moved" : "Edited";
function itemFacts(item: WorkItem): ReactNode {
	if (item.block.type === "diff") { const stats = diffStats(item.block); return <Stats added={stats.added} removed={stats.removed} />; }
	if (item.block.type === "document") return <span className="change-summary">{item.block.change.summary}</span>;
	if (item.block.type === "image" || item.block.type === "brief") return null;
	const unlisted = item.block.shown.items.reduce((sum, entry) => sum + (entry.unlisted?.count ?? 0), 0);
	return <span className="change-summary">{item.block.shown.items.length ? `${item.block.shown.items.length} item${item.block.shown.items.length === 1 ? "" : "s"}` : ""}
		{unlisted ? <span className="work-warning"> · {unlisted} change{unlisted === 1 ? "" : "s"} not mentioned</span> : null}</span>;
}

/** One line in the conversation for a change; it opens in the side pane. */
export function WorkChip({ item, status }: { item: WorkItem; status?: ReactNode }) {
	const open = useContext(WorkFocus);
	return <button type="button" className={`tool-card work-chip work-chip-${item.block.type}`} onClick={() => open(item)} title="Open beside the conversation">
		<span className="tool-icon"><Icon name={itemIcon(item)} /></span><strong>{itemKind(item)}</strong>
		<span className="tool-argument-preview"><span className="work-chip-name">{itemTitle(item)}</span>{itemPreview(item) && <> · {itemPreview(item)}</>}</span>
		{item.block.type === "diff" && itemFacts(item)}{status}<span className="work-chip-open" aria-hidden="true">›</span>
	</button>;
}
const itemIcon = (item: WorkItem) => item.block.type === "brief" ? "info" : item.block.type === "image" ? "preview" : item.block.type === "document" ? "layers"
	: item.block.type === "diff" && item.block.action === "deleted" ? "trash" : item.block.type === "diff" && item.block.action === "added" ? "plus" : "edit";
/** A taste of the change, as tool rows show their arguments: the first changed line, or a document's summary. */
function itemPreview(item: WorkItem): string {
	if (item.block.type === "document") return item.block.change.summary;
	if (item.block.type !== "diff") return "";
	if (item.block.note) return item.block.note;
	// Diff lines are "+ <line number> <text>"; the text keeps its own indentation, so a changed line may start with spaces.
	const text = (line: string, sign: string) => line.startsWith(sign) ? line.replace(/^[+-]\s*\d+ /, "").trim() : "";
	const lines = item.block.text.split("\n");
	const changed = lines.map(line => text(line, "+")).find(Boolean) ?? lines.map(line => text(line, "-")).find(Boolean);
	return (changed ?? lines[0]!).slice(0, 160);
}
function ShownNote({ note }: { note: string }) {
	return <div className="markdown shown-note"><Markdown remarkPlugins={markdownPlugins()}
		components={{ a: ({ href, children }) => {
			const url = href && shownUrl(href);
			return url ? <a href={url} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
		} }}>{note}</Markdown></div>;
}
function ShownLink({ item }: { item: ShownItem }) {
	const url = item.url && shownUrl(item.url);
	return url ? <a className="shown-link" href={url} target="_blank" rel="noopener noreferrer" title={url}>
		<Icon name="globe" /><span><strong>{item.label || new URL(url).hostname}</strong><small>{url}</small></span><span aria-hidden="true">↗</span>
	</a> : <p className="muted">This link cannot be opened.</p>;
}

/** Shown notes and web links are directly readable; files open in the side pane. */
export function ShownSummary({ item, time }: { item: WorkItem & { block: ShownBlock }; time?: ReactNode }) {
	const open = useContext(WorkFocus), { shown } = item.block;
	return <section className="shown-card">
		<header><span className="shown-badge"><Icon name="preview" />Shown</span><strong>{shown.title}</strong>{time}
			<span className="change-actions"><Reply text={() => shown.title} /></span></header>
		{shown.note && <ShownNote note={shown.note} />}
		{shown.items.filter(entry => entry.url).map((entry, index) => <ShownLink key={index} item={entry} />)}
		{shown.items.some(entry => !entry.url) && <button type="button" className="work-chip shown-open" onClick={() => open(item)}>
			<Icon name="layers" /><span>{shown.items.map(entry => entry.path ? name(entry.path) : entry.described ? "Described changes" : "").filter(Boolean).join(", ") || "Details"}</span>
			{itemFacts(item)}<span className="work-chip-open" aria-hidden="true">›</span></button>}
	</section>;
}

let highlighter: Promise<typeof import("./code-highlight.ts")> | undefined;
function useHighlighter() {
	const [module, setModule] = useState<typeof import("./code-highlight.ts")>();
	useEffect(() => { let live = true; void (highlighter ??= import("./code-highlight.ts")).then(value => { if (live) setModule(value); }); return () => { live = false; }; }, []);
	return module;
}
type DiffRow = { kind: "add" | "remove" | "same" | "gap" | "hunk"; number?: string; code: string };
/** Pi's numbered edit diff ("+12 text") or a unified diff ("+text", "@@ … @@"). */
export function diffRows(text: string): DiffRow[] {
	return text.split("\n").map((line): DiffRow => {
		if (/^@@/.test(line)) return { kind: "hunk", code: line };
		if (/^\s+\.\.\.$/.test(line)) return { kind: "gap", code: "…" };
		const numbered = /^([+\- ])(\s*\d+) (.*)$/s.exec(line);
		const sign = numbered?.[1] ?? line[0], code = numbered ? numbered[3]! : line.slice(1);
		return { kind: sign === "+" ? "add" : sign === "-" ? "remove" : "same", number: numbered?.[2]?.trim(), code };
	});
}
function CodeDiff({ text, path, limit }: { text: string; path?: string; limit?: number }) {
	const highlight = useHighlighter(), language = highlight?.languageFor(path);
	const rows = diffRows(text), shown = limit ? rows.slice(0, limit) : rows;
	return <div className="code-diff" role="table" aria-label={`Changes to ${path ? name(path) : "the file"}`}>
		{shown.map((row, index) => <div key={index} role="row" className={`code-row code-${row.kind}`}>
			<span className="code-number">{row.number}</span><span className="code-sign">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : ""}</span>
			{highlight && row.kind !== "gap" && row.kind !== "hunk" ? <code dangerouslySetInnerHTML={{ __html: highlight.highlightLine(row.code, language) || " " }} /> : <code>{row.code || " "}</code>}
		</div>)}
		{limit && rows.length > limit && <div className="code-row code-gap"><span className="code-number" /><span className="code-sign" /><code>… {rows.length - limit} more lines in the expanded view</code></div>}
	</div>;
}
function CodeExcerpt({ text, firstLine, path }: { text: string; firstLine: number; path?: string }) {
	return <CodeDiff path={path} text={text.split("\n").map((line, index) => ` ${firstLine + index} ${line}`).join("\n")} />;
}

/** An image from the agent's computer: fitted, or at full size to inspect, when zoom is allowed. */
function InlineImage({ session, file, zoom }: { session: string; file: FileReference; zoom?: boolean }) {
	const origin = useReferenceQuery();
	const [url, setUrl] = useState(""), [error, setError] = useState(""), [full, setFull] = useState(false);
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
	if (!url) return <p className="muted">{error || "Loading image…"}</p>;
	return <div className={`shown-image-frame${full ? " full" : ""}`}>
		<img className="shown-image" src={url} alt={file.name} onClick={zoom ? () => setFull(value => !value) : undefined}
			title={zoom ? full ? "Fit to the window" : "Show at full size" : undefined} />
	</div>;
}

/** An image a tool returned, from the conversation's assets: fitted, or at full size when zoom is allowed. */
function ViewedImage({ session, asset, name, zoom }: { session: string; asset: string; name: string; zoom?: boolean }) {
	const origin = useReferenceQuery();
	const [url, setUrl] = useState(""), [error, setError] = useState(""), [full, setFull] = useState(false);
	useEffect(() => {
		setUrl(""); setError("");
		const lease = acquireAsset(session, asset, origin);
		let live = true;
		void lease.loaded.then(value => { if (live) setUrl(value); }, reason => { if (live) setError(String(reason)); });
		return () => { live = false; lease.release(); };
	}, [session, asset, origin]);
	if (!url) return <p className="muted">{error || "Loading image…"}</p>;
	return <div className={`shown-image-frame${full ? " full" : ""}`}>
		<img className="shown-image" src={url} alt={name} onClick={zoom ? () => setFull(value => !value) : undefined}
			title={zoom ? full ? "Fit to the window" : "Show at full size" : undefined} />
	</div>;
}

/**
 * An HTML page the agent showed, live: Desk's sandbox page (public/sandbox.html) runs it with an opaque origin and no
 * network access, and reports its height so the frame fits it.
 */
function HtmlPage({ session, file, large }: { session: string; file: FileReference; large?: boolean }) {
	const origin = useReferenceQuery(), frame = useRef<HTMLIFrameElement>(null);
	const [html, setHtml] = useState<string>(), [error, setError] = useState(""), [height, setHeight] = useState(160);
	useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			try {
				const info = await api<FileInfo>(`/sessions/${session}/files/${file.id}?${origin}`);
				if (info.kind !== "text") throw new Error("Not a text file.");
				setHtml(await (await fileBlob(session, info, origin, controller.signal, () => {})).text());
			} catch (error) { if (!controller.signal.aborted) setError(String(error)); }
		})();
		return () => controller.abort();
	}, [session, file.id, origin]);
	useEffect(() => {
		const sized = (event: MessageEvent) => {
			const data = event.data as { type?: unknown; height?: unknown } | null;
			if (event.source !== frame.current?.contentWindow || data?.type !== "height" || typeof data.height !== "number" || !Number.isFinite(data.height)) return;
			setHeight(Math.min(Math.max(Math.ceil(data.height), 60), large ? 4000 : 640));
		};
		addEventListener("message", sized);
		return () => removeEventListener("message", sized);
	}, [large]);
	if (html === undefined) return <p className="muted">{error || "Loading page…"}</p>;
	return <iframe ref={frame} className="shown-html" src="/sandbox.html" sandbox="allow-scripts" title={file.name} style={{ height }}
		onLoad={() => frame.current?.contentWindow?.postMessage({ type: "render", html }, "*")} />;
}

function ShownEntry({ item, file, session, title, large }: { item: ShownItem; file: FileReference | null; session: string; title: string; large?: boolean }) {
	const where = item.path ? name(item.path) : title;
	if (item.url) return <ShownLink item={item} />;
	return <div className="shown-item">
		{item.path && <div className="shown-item-heading"><FileName session={session} path={item.path} file={file} />
			{item.missing && <span className="error-text">not found</span>}
			{item.changes && <span className="change-summary">{item.changes.summary}</span>}
			{item.diff && <Stats added={item.diff.added} removed={item.diff.removed} />}</div>}
		{item.unlisted && <p className="shown-warning" role="note"><Icon name="warning" />Desk found {item.unlisted.count} changed cell{item.unlisted.count === 1 ? "" : "s"} the agent did not mention: {item.unlisted.examples.join(", ")}{item.unlisted.count > item.unlisted.examples.length ? ", …" : ""}</p>}
		{item.kind === "image" && file && <InlineImage session={session} file={file} zoom={large} />}
		{item.kind === "html" && file && <HtmlPage session={session} file={file} large={large} />}
		{item.changes && <DocumentChangesView changes={item.changes} where={where} />}
		{item.diff && <CodeDiff text={item.diff.text} path={item.path} limit={large ? undefined : 80} />}
		{item.preview && <PreviewView preview={item.preview} />}
		{item.excerpt && <CodeExcerpt text={item.excerpt.text} firstLine={item.excerpt.firstLine} path={item.path} />}
		{item.described && <p className="change-source">Described by the agent</p>}
		{item.described && <ul className="shown-described">{item.described.map((change, index) => <li key={index}>
			<code>{change.where}</code>{change.before !== undefined && <del>{change.before}</del>}{change.before !== undefined && change.after !== undefined && <span aria-hidden="true">→</span>}{change.after !== undefined && <ins>{change.after}</ins>}
			<Reply label="" text={() => `${where} ${change.where}: ${change.before ?? ""}${change.after !== undefined ? ` → ${change.after}` : ""}`} />
		</li>)}</ul>}
	</div>;
}

/** What an item contains, at pane or expanded size. */
export function WorkBody({ item, session, large }: { item: WorkItem; session: string; large?: boolean }) {
	const { block } = item;
	if (block.type === "diff") return <>
		{block.note ? <p className="muted work-note">{block.note}</p> : <CodeDiff text={block.text} path={block.movePath ?? block.path} limit={large ? undefined : 120} />}
		{block.truncated && <p className="muted work-note">Diff preview limited to 12,000 characters.</p>}
		{block.full && <AssetLink session={session} asset={block.full} />}
	</>;
	if (block.type === "image") return <ViewedImage session={session} asset={block.asset} name={item.title ?? "Image"} zoom={large} />;
	if (block.type === "brief") return <BriefView brief={block.brief} working={block.working} rewrite={block.rewrite} />;
	if (block.type === "document") return <>
		{block.change.changes && <DocumentChangesView changes={block.change.changes} where={name(block.change.path)} />}
		{block.change.preview && <PreviewView preview={block.change.preview} />}
	</>;
	return <>
		{block.shown.note && <ShownNote note={block.shown.note} />}
		{!block.shown.note && !block.shown.items.length && <p className="muted work-note">No details were provided for this result.</p>}
		{block.shown.items.map((entry, index) => <ShownEntry key={index} item={entry} file={block.files[index] ?? null} session={session} title={block.shown.title} large={large} />)}
	</>;
}
function quoteFor(item: WorkItem): string {
	const { block } = item;
	return block.type === "diff" ? `${block.path}\n${block.text.split("\n").filter(line => /^[+-]/.test(line)).slice(0, 12).join("\n")}`
		: block.type === "document" ? `${name(block.change.path)}: ${block.change.summary}` : block.type === "image" ? `Image: ${item.title ?? ""}`
		: block.type === "brief" ? block.brief.markdown.slice(0, 600) : block.shown.title;
}
function ItemHeader({ item, session, children }: { item: WorkItem; session: string; children?: ReactNode }) {
	const path = item.block.type === "diff" ? item.block.movePath ?? item.block.path : item.block.type === "document" ? item.block.change.path : undefined;
	const file = item.block.type === "diff" || item.block.type === "document" ? item.block.file : undefined;
	return <header className="work-item-header">
		<span className="change-kind">{itemKind(item)}</span>
		{path ? <FileName session={session} path={path} file={file} /> : <strong>{itemTitle(item)}</strong>}
		{itemFacts(item)}
		<span className="change-actions">{item.block.type === "diff" && <CopyButton text={() => (item.block as DiffBlock).text} label="Copy" />}
			<Reply text={() => quoteFor(item)} />{children}</span>
	</header>;
}

/** Beside the conversation: what the agent changed and showed, newest first, with the selected one open. */
export function WorkPane({ items, links, selected, select, expand, close, session }: {
	items: WorkItem[]; links: LinkItem[]; selected?: string; select: (id: string) => void; expand: (item: WorkItem) => void; close: () => void; session: string;
}) {
	const newest = [...items].reverse(), current = newest.find(item => item.id === selected) ?? newest[0];
	const width = useRef<HTMLElement>(null);
	const resize = (event: React.PointerEvent) => {
		const pane = width.current; if (!pane) return;
		const startX = event.clientX, startWidth = pane.getBoundingClientRect().width;
		const move = (moved: PointerEvent) => {
			const next = Math.min(Math.max(320, startWidth + startX - moved.clientX), window.innerWidth * 0.7);
			document.documentElement.style.setProperty("--work-pane", `${Math.round(next)}px`);
		};
		const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up);
			localStorage.setItem("pi-desk:work-pane-width", getComputedStyle(document.documentElement).getPropertyValue("--work-pane").trim()); };
		addEventListener("pointermove", move); addEventListener("pointerup", up);
	};
	return <aside className="work-pane" aria-label="Changes and shown work" ref={width}>
		<div className="work-pane-resize" onPointerDown={resize} aria-hidden="true" />
		<div className="work-pane-heading"><strong>Changes</strong><small>{items.length}</small>
			<button type="button" className="icon-button" title="Hide" aria-label="Hide changes" onClick={close}><Icon name="close" /></button></div>
		{current && <ReferenceContext value={{ message: current.message, source: current.source }}><section className="work-current">
			<ItemHeader item={current} session={session}><button type="button" className="icon-button" title="Expand" aria-label="Expand" onClick={() => expand(current)}><Icon name="expand" /></button></ItemHeader>
			<div className="work-current-body"><WorkBody item={current} session={session} /></div>
		</section></ReferenceContext>}
		{newest.length > 1 && <ol className="work-list">{newest.map(item => <li key={item.id}>
			<button type="button" className="work-list-item" aria-current={item === current ? "true" : undefined} onClick={() => select(item.id)}>
				<span className="change-kind">{itemKind(item)}</span><strong>{itemTitle(item)}</strong>{itemFacts(item)}
				<time>{new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
			</button></li>)}</ol>}
		{links.length > 0 && <section className="work-links" aria-label="Links">
			<h3>Links<small>{links.length}</small></h3>
			<ol>{[...links].reverse().map(link => <li key={link.key}>
				<Icon name={link.file ? "folder" : "globe"} />
				{link.file ? <ReferenceContext value={{ message: link.message }}><FileLink session={session} file={link.file}>{link.label}</FileLink></ReferenceContext>
					: <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>{link.label}</a>}
				<time>{new Date(link.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
			</li>)}</ol>
		</section>}
	</aside>;
}

/** The expanded view: the whole item at full size, images zoomable. */
export function WorkModal({ item, session, close }: { item: WorkItem; session: string; close: () => void }) {
	return <SurfaceFrame className="work-modal" label={itemTitle(item)} close={close} portal><ReferenceContext value={{ message: item.message, source: item.source }}>
		<ItemHeader item={item} session={session}><button type="button" className="icon-button" aria-label="Close" onClick={close}><Icon name="close" /></button></ItemHeader>
		<div className="work-modal-body"><WorkBody item={item} session={session} large /></div>
	</ReferenceContext></SurfaceFrame>;
}
