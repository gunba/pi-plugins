import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { attributes, cellPosition, columnName, decode, runs, workbookParts } from "./documents.ts";
import { unzip } from "./zip.ts";

/**
 * Office and PDF files as text for an agent to read: Word paragraphs and tables, slides with their notes, sheets as
 * grids of values with their formulas, PDF text by page. Lines are what read pages through with offset and limit.
 */

const clean = (text: string) => text.replace(/[\t\r\n]+/g, " ").trim();

/**
 * Paragraphs and tables of a WordprocessingML or DrawingML body, in order. A table becomes one "| a | b |" line a row;
 * a table inside a cell becomes text in that cell.
 */
function flow(xml: string, prefix: "w" | "a", paragraph: (inner: string) => string): string[] {
	const lines: string[] = [], tables: { row: string[]; cell: string[] }[] = [];
	const token = new RegExp(`<${prefix}:tbl\\b[^>]*>|</${prefix}:tbl>|<${prefix}:tr\\b[^>]*>|</${prefix}:tr>|<${prefix}:tc\\b[^>]*?(/?)>|</${prefix}:tc>|<${prefix}:p\\b[^>]*?/>|<${prefix}:p\\b[^>]*>([\\s\\S]*?)</${prefix}:p>`, "g");
	for (const match of xml.matchAll(token)) {
		const tag = match[0], table = tables.at(-1), name = /^<\/?\w+:(\w+)/.exec(tag)![1], closing = tag.startsWith("</");
		if (name === "tbl" && !closing) tables.push({ row: [], cell: [] });
		else if (name === "tbl") {
			tables.pop();
			if (tables.length && table) tables.at(-1)!.cell.push(...table.row);
		} else if (name === "p") { const text = paragraph(match[2] ?? ""); if (!table) lines.push(text); else table.cell.push(clean(text)); }
		else if (!table) continue;
		else if (name === "tr" && !closing) { if (tables.length === 1) table.row = []; }
		else if (name === "tr") { if (tables.length === 1 && table.row.some(Boolean)) lines.push(`| ${table.row.join(" | ")} |`); }
		else if (name === "tc" && !closing) { table.cell = []; if (match[1]) table.row.push(""); }
		else if (name === "tc") {
			const text = clean(table.cell.filter(Boolean).join(" / "));
			if (tables.length === 1) table.row.push(text.replace(/\|/g, "\\|")); else tables.at(-2)?.cell.push(text);
		}
	}
	return lines;
}

export function docxText(data: Buffer): string {
	const xml = unzip(data, name => name === "word/document.xml").get("word/document.xml")?.toString("utf8");
	if (xml === undefined) throw new Error("This Word file has no document body.");
	const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
	return flow(body, "w", inner => {
		const style = /<w:pStyle w:val="([^"]*)"/.exec(inner)?.[1] ?? "", level = /^heading ?(\d)$/i.exec(style)?.[1];
		const text = runs(inner, "w");
		if (!text.trim()) return "";
		return (style === "Title" ? "# " : level ? `${"#".repeat(Number(level))} ` : /<w:numPr>/.test(inner) ? "- " : "") + text;
	}).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function pptxText(data: Buffer): string {
	const files = unzip(data, name => name === "ppt/presentation.xml" || name === "ppt/_rels/presentation.xml.rels"
		|| /^ppt\/(slides|notesSlides)\/(_rels\/)?[^/]+\.xml(\.rels)?$/.test(name));
	const text = (name: string) => files.get(name)?.toString("utf8") ?? "";
	const target = (from: string, path: string) => path.startsWith("/") ? path.slice(1) : posix.join(posix.dirname(from), path);
	const relations = (part: string) => [...text(posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`))
		.matchAll(/<Relationship\b([^>]*)\/?>/g)].map(match => attributes(match[1]!));
	const deck = new Map(relations("ppt/presentation.xml").map(relation => [relation.Id ?? "", relation.Target ?? ""]));
	const order = [...text("ppt/presentation.xml").matchAll(/<p:sldId\b([^>]*)\/?>/g)]
		.map(match => deck.get(attributes(match[1]!)["r:id"] ?? "")).filter((path): path is string => !!path).map(path => target("ppt/presentation.xml", path));
	const lines = (xml: string) => flow(xml, "a", inner => runs(inner, "a")).filter(line => line.trim());
	return order.map((slide, index) => {
		const xml = text(slide), notesPath = relations(slide).find(relation => relation.Type?.endsWith("/notesSlide"))?.Target;
		// The speaker notes are the notes page's body placeholder; its other shapes are the slide image and number.
		const notes = notesPath ? [...text(target(slide, notesPath)).matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)]
			.filter(shape => /<p:ph\b[^>]*type="body"/.test(shape[1]!)).flatMap(shape => lines(shape[1]!)) : [];
		const hidden = /<p:sld\b[^>]*\bshow="0"/.test(xml) ? " (hidden)" : "";
		return [`--- Slide ${index + 1}${hidden} ---`, ...lines(xml), ...(notes.length ? ["Notes:", ...notes] : [])].join("\n");
	}).join("\n\n");
}

/** Number formats Excel shows as dates or times: its built-in ones, and custom codes with date or time parts. */
function dateFormats(styles: string): boolean[] {
	const custom = new Map([...styles.matchAll(/<numFmt\b([^>]*)\/?>/g)].map(match => { const format = attributes(match[1]!); return [Number(format.numFmtId), format.formatCode ?? ""] as const; }));
	const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
	return [...xfs.matchAll(/<xf\b([^>]*?)\/?>/g)].map(match => {
		const id = Number(attributes(match[1]!).numFmtId ?? 0), code = custom.get(id);
		if (code === undefined) return id >= 14 && id <= 22 || id >= 27 && id <= 36 || id >= 45 && id <= 47 || id >= 50 && id <= 58;
		return /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ""));
	});
}
/** An Excel serial date as ISO text: a date, a time, or both. */
function serialDate(serial: number, from1904: boolean): string {
	// Excel's 1900 calendar counts 29 February 1900, which never was: serials before it are a day further on.
	const days = from1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial;
	const at = new Date(Date.UTC(1899, 11, 30) + Math.round(days * 86_400_000)).toISOString();
	const date = at.slice(0, 10), time = at.slice(11, 19).replace(/:00$/, "");
	return serial < 1 ? time : Number.isInteger(serial) ? date : `${date} ${time}`;
}

/** A1 references in a formula moved by (columns, rows), as Excel fills a shared formula; strings and names stay. */
function shift(formula: string, columns: number, rows: number): string {
	const column = (fixed: string, name: string) => fixed ? fixed + name : columnName(cellPosition(`${name}1`)[0] + columns);
	const row = (fixed: string, number: string) => fixed ? fixed + number : String(Number(number) + rows);
	return formula.replace(/("(?:[^"]|"")*"|'(?:[^']|'')*')|(?<![\w.$])(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![\w(])|(?<![\w.$])(\$?)([A-Z]{1,3}):(\$?)([A-Z]{1,3})(?![\w(])|(?<![\w.$:])(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\w(.])/g,
		(match, quoted, fixedColumn, letters, fixedRow, digits, fixedStart, start, fixedEnd, end, fixedTop, top, fixedBottom, bottom) => {
			if (quoted) return match;
			if (letters) return column(fixedColumn, letters) + row(fixedRow, digits);
			if (start) return `${column(fixedStart, start)}:${column(fixedEnd, end)}`;
			return `${row(fixedTop, top)}:${row(fixedBottom, bottom)}`;
		});
}

/**
 * Each sheet as a grid: a header of column letters, then each row that has cells, led by its number, with its cells
 * separated by tabs. A formula follows its value as "value (=formula)"; dates are shown as dates. A list of the sheets
 * and the lines they start on comes first, so a large workbook can be read a sheet at a time.
 */
export function xlsxText(data: Buffer): string {
	const book = workbookParts(data), dates = dateFormats(book.styles), from1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(book.workbook);
	const sheets = book.sheets.map(sheet => {
		const rows = new Map<number, Map<number, string>>(), masters = new Map<string, { formula: string; column: number; row: number }>();
		let left = Infinity, right = -1;
		for (const cell of sheet.xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
			const { r: ref, t: type, s: style } = attributes(cell[1]!), inner = cell[2] ?? "";
			if (!ref) continue;
			const [column, row] = cellPosition(ref);
			const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1], tag = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
			// Functions newer than the file format carry a prefix Excel doesn't show.
			let formula = tag?.[2] !== undefined ? decode(tag[2]).replace(/_xl(?:fn|ws)\./g, "") : undefined;
			const shared = tag ? attributes(tag[1]!) : undefined;
			if (shared?.t === "shared" && shared.si !== undefined) {
				if (formula !== undefined) masters.set(shared.si, { formula, column, row });
				else { const master = masters.get(shared.si); if (master) formula = shift(master.formula, column - master.column, row - master.row); }
			}
			let value = type === "s" ? book.strings[Number(raw)] ?? "" : type === "b" ? raw === undefined ? "" : raw === "1" ? "TRUE" : "FALSE"
				: type === "inlineStr" ? runs(inner.replace(/<(\/?)t\b/g, "<$1a:t"), "a") : decode(raw ?? "");
			if (raw !== undefined && (!type || type === "n") && dates[Number(style ?? 0)] && Number.isFinite(Number(raw))) value = serialDate(Number(raw), from1904);
			const shown = (clean(value) + (formula !== undefined ? ` (=${clean(formula)})` : "")).trim();
			if (!shown) continue;
			if (!rows.has(row)) rows.set(row, new Map());
			rows.get(row)!.set(column, shown);
			left = Math.min(left, column); right = Math.max(right, column);
		}
		const title = `"${sheet.name}"${sheet.hidden ? " (hidden)" : ""}`;
		if (right < 0) return { title: `${title}: empty`, lines: [] };
		const numbers = [...rows.keys()].sort((a, b) => a - b), columns = Array.from({ length: right - left + 1 }, (_, index) => left + index);
		return { title: `${title} ${columnName(left)}${numbers[0]! + 1}:${columnName(right)}${numbers.at(-1)! + 1}`, lines: [["", ...columns.map(columnName)].join("\t"),
			...numbers.map(row => [String(row + 1), ...columns.map(column => rows.get(row)!.get(column) ?? "")].join("\t").replace(/\t+$/, ""))] };
	});
	// The list's own lines, its blank line, then each sheet's heading, rows and blank line.
	let line = sheets.length + 3;
	const starts = sheets.map(sheet => { const start = line; line += sheet.lines.length + 2; return start; });
	return [`Sheets (${sheets.length}), with the line each starts on:`, ...sheets.map((sheet, index) => `- ${sheet.title} (line ${starts[index]})`), "",
		...sheets.map(sheet => [`--- Sheet ${sheet.title} ---`, ...sheet.lines, ""].join("\n"))].join("\n").trimEnd();
}

let pdfjs: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
type Canvases = { create(width: number, height: number): { canvas: { toBuffer(type: "image/png"): Buffer }; context: CanvasRenderingContext2D } };
/** A PDF opened with pdf.js, loaded on first use: it is large, and most conversations never read a PDF. */
async function withPdf<T>(data: Buffer, use: (document: Awaited<ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs")["getDocument"]>["promise"]>) => Promise<T>): Promise<T> {
	pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs");
	const library = await pdfjs, root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
	const task = library.getDocument({ data: new Uint8Array(data), verbosity: 0,
		standardFontDataUrl: join(root, "standard_fonts") + "/", cMapUrl: join(root, "cmaps") + "/", cMapPacked: true });
	try { return await use(await task.promise); } finally { await task.destroy(); }
}

export function pdfText(data: Buffer): Promise<string> {
	return withPdf(data, async document => {
		const pages: string[] = [];
		for (let number = 1; number <= document.numPages; number++) {
			const content = await (await document.getPage(number)).getTextContent();
			const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join("")
				.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
			pages.push(`--- Page ${number} of ${document.numPages} ---\n${text || "(no text: a scanned page or only images; read it with page to see it)"}`);
		}
		return pages.join("\n\n");
	});
}

/** One page as a PNG, its longer side about 2,000 pixels; read then fits it to the model. */
export function pdfPage(data: Buffer, number: number): Promise<Buffer> {
	return withPdf(data, async document => {
		if (!Number.isInteger(number) || number < 1 || number > document.numPages)
			throw new Error(`There is no page ${number}: the file has ${document.numPages} page${document.numPages === 1 ? "" : "s"}.`);
		const page = await document.getPage(number), size = page.getViewport({ scale: 1 });
		const viewport = page.getViewport({ scale: Math.min(4, 2000 / Math.max(size.width, size.height)) });
		const { canvas, context } = (document.canvasFactory as Canvases).create(Math.ceil(viewport.width), Math.ceil(viewport.height));
		await page.render({ canvasContext: context, viewport, canvas: canvas as unknown as HTMLCanvasElement }).promise;
		return canvas.toBuffer("image/png");
	});
}
