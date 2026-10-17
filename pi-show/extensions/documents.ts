import { diffSequences } from "./sequence-diff.ts";
import { unzip } from "./zip.ts";

export type Cell = { value: string; formula?: string };
export type Workbook = { kind: "xlsx"; sheets: { name: string; cells: Map<string, Cell> }[] };
export type WordDocument = { kind: "docx"; paragraphs: string[] };
export type Deck = { kind: "pptx"; slides: string[][] };
export type OfficeDocument = Workbook | WordDocument | Deck;

export type CellChange = { sheet: string; cell: string; before?: string; after?: string; formulaBefore?: string; formulaAfter?: string };
/** Paragraphs kept, removed or added; a gap stands for unchanged paragraphs left out. */
export type ParagraphOp = { op: "=" | "-" | "+"; text: string } | { op: "gap"; count: number };
export type DocumentChanges =
	| { kind: "xlsx"; summary: string; sheetsAdded: string[]; sheetsRemoved: string[]; cells: CellChange[]; total: number }
	| { kind: "docx"; summary: string; paragraphs: ParagraphOp[]; truncated: boolean }
	| { kind: "pptx"; summary: string; slides: { slide: number; status: "added" | "removed" | "changed"; paragraphs: ParagraphOp[] }[] };
export type DocumentPreview =
	| { kind: "xlsx"; sheet: string; sheets: string[]; firstRow: number; firstColumn: number; rows: { value: string; formula?: string }[][]; truncated: boolean }
	| { kind: "docx"; paragraphs: string[]; truncated: boolean }
	| { kind: "pptx"; slides: { slide: number; paragraphs: string[] }[]; truncated: boolean };

export const OFFICE = /\.(xlsx|xlsm|docx|docm|pptx|pptm)$/i;
export const officeKind = (path: string): OfficeDocument["kind"] | undefined => {
	const extension = OFFICE.exec(path)?.[1]?.toLowerCase();
	return extension?.startsWith("xls") ? "xlsx" : extension?.startsWith("doc") ? "docx" : extension?.startsWith("ppt") ? "pptx" : undefined;
};

const decode = (text: string) => text.replace(/&(?:#(\d+)|#x([\da-f]+)|(lt|gt|amp|quot|apos));/gi, (_entity, decimal: string, hex: string, name: string) =>
	decimal ? String.fromCodePoint(Number(decimal)) : hex ? String.fromCodePoint(parseInt(hex, 16))
		: ({ lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" } as Record<string, string>)[name.toLowerCase()]!);
const attributes = (text: string) => Object.fromEntries([...text.matchAll(/([\w:]+)="([^"]*)"/g)].map(match => [match[1]!, decode(match[2]!)]));
/** Text of the runs in a fragment: <x:t> elements, tabs and breaks. */
const runs = (xml: string, prefix: "w" | "a") => [...xml.matchAll(new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([\\s\\S]*?)</${prefix}:t>|<${prefix}:(tab|br|cr)/>`, "g"))]
	.map(match => match[2] === "tab" ? "\t" : match[2] ? "\n" : decode(match[1]!)).join("");

/** A1 reference as zero-based [column, row]. */
export function cellPosition(ref: string): [number, number] {
	const match = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref);
	if (!match) return [0, 0];
	let column = 0;
	for (const letter of match[1]!.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
	return [column - 1, Number(match[2]) - 1];
}
export function columnName(index: number): string {
	let name = "";
	for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
	return name;
}

export function readOffice(data: Buffer, kind: OfficeDocument["kind"]): OfficeDocument {
	if (kind === "docx") {
		const xml = unzip(data, name => name === "word/document.xml").get("word/document.xml")?.toString("utf8");
		if (xml === undefined) throw new Error("No document body.");
		return { kind, paragraphs: [...xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)].map(match => runs(match[1] ?? "", "w")) };
	}
	if (kind === "pptx") {
		const files = unzip(data, name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
		const slides = [...files].sort(([a], [b]) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
		return { kind, slides: slides.map(([, xml]) => [...xml.toString("utf8").matchAll(/<a:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)]
			.map(match => runs(match[1] ?? "", "a")).filter(text => text.trim())) };
	}
	const files = unzip(data, name => name === "xl/workbook.xml" || name === "xl/_rels/workbook.xml.rels" || name === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(name));
	const text = (name: string) => files.get(name)?.toString("utf8") ?? "";
	const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)]
		.map(match => [...match[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(run => decode(run[1]!)).join(""));
	const targets = new Map([...text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b([^>]*)\/?>/g)].map(match => {
		const relation = attributes(match[1]!), target = relation.Target ?? "";
		return [relation.Id ?? "", target.startsWith("/") ? target.slice(1) : `xl/${target}`];
	}));
	const sheets = [...text("xl/workbook.xml").matchAll(/<sheet\b([^>]*)\/?>/g)].map(match => {
		const sheet = attributes(match[1]!), cells = new Map<string, Cell>();
		for (const cell of text(targets.get(sheet["r:id"] ?? "") ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
			const { r: ref, t: type } = attributes(cell[1]!), inner = cell[2] ?? "";
			if (!ref) continue;
			const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1], formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(inner)?.[1];
			const value = type === "s" ? shared[Number(raw)] ?? "" : type === "b" ? raw === "1" ? "TRUE" : "FALSE"
				: type === "inlineStr" ? runs(inner.replace(/<(\/?)t\b/g, "<$1a:t"), "a") : decode(raw ?? "");
			if (value || formula) cells.set(ref.toUpperCase(), { value, ...(formula ? { formula: decode(formula) } : {}) });
		}
		return { name: sheet.name ?? "Sheet", cells };
	});
	return { kind: "xlsx", sheets };
}

const byPosition = (a: string, b: string) => { const [ac, ar] = cellPosition(a), [bc, br] = cellPosition(b); return ar - br || ac - bc; };

/** Paragraph operations with long unchanged stretches folded into gaps. */
function paragraphOps(before: string[], after: string[], context = 1, limit = 300): { ops: ParagraphOp[]; truncated: boolean; added: number; removed: number; changed: number } {
	const diff = diffSequences(before, after) ?? [...before.map((_, a): { op: "-"; a: number } => ({ op: "-", a })), ...after.map((_, b): { op: "+"; b: number } => ({ op: "+", b }))];
	const keep = new Set<number>();
	diff.forEach((op, index) => { if (op.op !== "=") for (let near = index - context; near <= index + context; near++) keep.add(near); });
	const ops: ParagraphOp[] = [];
	let gap = 0, added = 0, removed = 0, changed = 0, run = { added: 0, removed: 0 };
	const close = () => { const both = Math.min(run.added, run.removed); changed += both; added += run.added - both; removed += run.removed - both; run = { added: 0, removed: 0 }; };
	diff.forEach((op, index) => {
		if (op.op === "=") close(); else if (op.op === "+") run.added++; else run.removed++;
		if (!keep.has(index)) { gap++; return; }
		if (gap) { ops.push({ op: "gap", count: gap }); gap = 0; }
		ops.push({ op: op.op, text: op.op === "-" ? before[op.a!]! : after[op.b!]! });
	});
	close();
	if (gap) ops.push({ op: "gap", count: gap });
	return { ops: ops.slice(0, limit), truncated: ops.length > limit, added, removed, changed };
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What changed between two versions of an Office file, cell by cell, paragraph by paragraph or slide by slide. */
export function diffOffice(before: OfficeDocument, after: OfficeDocument, limit = 400): DocumentChanges | undefined {
	if (before.kind !== after.kind) return;
	if (before.kind === "xlsx" && after.kind === "xlsx") {
		const old = new Map(before.sheets.map(sheet => [sheet.name, sheet.cells])), now = new Map(after.sheets.map(sheet => [sheet.name, sheet.cells]));
		const cells: CellChange[] = [];
		for (const sheet of after.sheets) {
			const previous = old.get(sheet.name);
			if (!previous) continue;
			for (const ref of [...new Set([...previous.keys(), ...sheet.cells.keys()])].sort(byPosition)) {
				const a = previous.get(ref), b = sheet.cells.get(ref);
				if (a?.value === b?.value && a?.formula === b?.formula) continue;
				cells.push({ sheet: sheet.name, cell: ref, ...(a?.value ? { before: a.value } : {}), ...(b?.value ? { after: b.value } : {}),
					...(a?.formula ? { formulaBefore: a.formula } : {}), ...(b?.formula ? { formulaAfter: b.formula } : {}) });
			}
		}
		const sheetsAdded = after.sheets.filter(sheet => !old.has(sheet.name)).map(sheet => sheet.name);
		const sheetsRemoved = before.sheets.filter(sheet => !now.has(sheet.name)).map(sheet => sheet.name);
		if (!cells.length && !sheetsAdded.length && !sheetsRemoved.length) return;
		const touched = new Set(cells.map(cell => cell.sheet)).size;
		const summary = [cells.length && `${plural(cells.length, "cell")} changed${touched > 1 ? ` in ${touched} sheets` : cells[0] ? ` in ${cells[0].sheet}` : ""}`,
			sheetsAdded.length && `${plural(sheetsAdded.length, "sheet")} added`, sheetsRemoved.length && `${plural(sheetsRemoved.length, "sheet")} removed`].filter(Boolean).join(", ");
		return { kind: "xlsx", summary, sheetsAdded, sheetsRemoved, cells: cells.slice(0, limit), total: cells.length };
	}
	if (before.kind === "docx" && after.kind === "docx") {
		const result = paragraphOps(before.paragraphs, after.paragraphs);
		if (!result.added && !result.removed && !result.changed) return;
		const summary = [result.changed && `${plural(result.changed, "paragraph")} changed`, result.added && `${result.added} added`, result.removed && `${result.removed} removed`].filter(Boolean).join(", ");
		return { kind: "docx", summary, paragraphs: result.ops, truncated: result.truncated };
	}
	if (before.kind === "pptx" && after.kind === "pptx") {
		const slides: Extract<DocumentChanges, { kind: "pptx" }>["slides"] = [];
		for (let index = 0; index < Math.max(before.slides.length, after.slides.length); index++) {
			const a = before.slides[index], b = after.slides[index];
			if (!a) slides.push({ slide: index + 1, status: "added", paragraphs: b!.map(text => ({ op: "+", text })) });
			else if (!b) slides.push({ slide: index + 1, status: "removed", paragraphs: a.map(text => ({ op: "-", text })) });
			else if (a.join("\n") !== b.join("\n")) slides.push({ slide: index + 1, status: "changed", paragraphs: paragraphOps(a, b).ops });
		}
		if (!slides.length) return;
		return { kind: "pptx", summary: `${plural(slides.length, "slide")} changed`, slides: slides.slice(0, 60) };
	}
}

/** A readable excerpt: a sheet range, the document's paragraphs or the slides' text. `focus` names a sheet or range ("Totals!B2:F20"). */
export function previewOffice(document: OfficeDocument, focus = "", maxRows = 40, maxColumns = 14): DocumentPreview {
	if (document.kind === "docx") {
		const paragraphs = document.paragraphs.filter(text => text.trim());
		const start = focus ? Math.max(0, paragraphs.findIndex(text => text.toLowerCase().includes(focus.toLowerCase()))) : 0;
		return { kind: "docx", paragraphs: paragraphs.slice(start, start + 80), truncated: paragraphs.length > start + 80 };
	}
	if (document.kind === "pptx") {
		const slides = document.slides.map((paragraphs, index) => ({ slide: index + 1, paragraphs }));
		return { kind: "pptx", slides: slides.slice(0, 30), truncated: slides.length > 30 };
	}
	const match = /^(?:'?([^'!]+)'?!)?(?:(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?)?$/i.exec(focus.trim());
	const named = match?.[1] ?? (match?.[2] ? undefined : focus.trim() || undefined);
	const sheet = document.sheets.find(item => item.name.toLowerCase() === named?.toLowerCase()) ?? document.sheets[0] ?? { name: "Sheet", cells: new Map<string, Cell>() };
	let [left, top] = match?.[2] ? cellPosition(match[2]) : [Infinity, Infinity], [right, bottom] = match?.[3] ? cellPosition(match[3]) : [-1, -1];
	if (!match?.[2]) for (const ref of sheet.cells.keys()) {
		const [column, row] = cellPosition(ref);
		left = Math.min(left, column); top = Math.min(top, row); right = Math.max(right, column); bottom = Math.max(bottom, row);
	}
	if (!match?.[3] && match?.[2]) { right = left + maxColumns - 1; bottom = top + maxRows - 1; }
	if (!Number.isFinite(left)) { left = 0; top = 0; right = 0; bottom = 0; }
	const rows: { value: string; formula?: string }[][] = [];
	for (let row = top; row <= Math.min(bottom, top + maxRows - 1); row++) {
		const values: { value: string; formula?: string }[] = [];
		for (let column = left; column <= Math.min(right, left + maxColumns - 1); column++) {
			const cell = sheet.cells.get(`${columnName(column)}${row + 1}`);
			values.push(cell ? { value: cell.value, ...(cell.formula ? { formula: cell.formula } : {}) } : { value: "" });
		}
		rows.push(values);
	}
	return { kind: "xlsx", sheet: sheet.name, sheets: document.sheets.map(item => item.name), firstRow: top + 1, firstColumn: left, rows,
		truncated: bottom - top + 1 > maxRows || right - left + 1 > maxColumns };
}

/**
 * Which computed cell changes an agent's own list of changes did not mention. A "where" naming a cell or range
 * ("Totals!B12", "C3:C9") covers the changed cells it contains.
 */
export function unlistedCells(changes: Extract<DocumentChanges, { kind: "xlsx" }>, wheres: string[]): CellChange[] {
	const ranges = wheres.flatMap(where => [...where.matchAll(/(?:'?([^'!,;]+?)'?!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?/gi)].map(match => {
		const [c1, r1] = cellPosition(match[2]!), [c2, r2] = match[3] ? cellPosition(match[3]) : [c1, r1];
		return { sheet: match[1]?.trim().toLowerCase(), left: Math.min(c1, c2), right: Math.max(c1, c2), top: Math.min(r1, r2), bottom: Math.max(r1, r2) };
	}));
	return changes.cells.filter(change => {
		const [column, row] = cellPosition(change.cell);
		return !ranges.some(range => (!range.sheet || range.sheet === change.sheet.toLowerCase())
			&& column >= range.left && column <= range.right && row >= range.top && row <= range.bottom);
	});
}
