import { createHash } from "node:crypto";
import { cellPosition, columnName, OFFICE, officeKind, readOffice, type Cell, type OfficeDocument } from "./documents.ts";

/**
 * What Desk keeps of a file to show its next change, instead of the file:
 * - Office documents: their content (cells and formulas, paragraphs, slide text). Spreadsheets are stored column by
 *   column with formulas relative to their cell, so a column of filled-down formulas is one repeated line.
 * - Other binary files: a fingerprint (size and hash), since their changes are reported, not diffed.
 * Text files are kept as they are.
 */
const OFFICE_HEADER = "desk-office 1 ", FILE_HEADER = "desk-file 1\n";
/** Office files larger than this are fingerprinted rather than read. */
const OFFICE_LIMIT = 64 * 1024 * 1024;

/** Patterns whose files go through the content filter; everything else is stored as is. */
export const FILTERED = ["*.xlsx", "*.xlsm", "*.docx", "*.docm", "*.pptx", "*.pptm",
	"*.xls", "*.doc", "*.ppt", "*.msg", "*.pst", "*.pdf", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.bmp", "*.tif", "*.tiff", "*.ico", "*.heic",
	"*.psd", "*.ai", "*.zip", "*.7z", "*.rar", "*.gz", "*.tgz", "*.bz2", "*.xz", "*.zst", "*.tar", "*.jar", "*.mp3", "*.mp4", "*.m4a", "*.wav", "*.flac",
	"*.ogg", "*.mov", "*.avi", "*.mkv", "*.webm", "*.exe", "*.dll", "*.so", "*.dylib", "*.bin", "*.o", "*.a", "*.lib", "*.pdb", "*.class", "*.wasm",
	"*.node", "*.sqlite", "*.db", "*.mdb", "*.accdb", "*.parquet", "*.feather", "*.pkl", "*.npy", "*.npz", "*.h5", "*.onnx", "*.safetensors", "*.pt",
	"*.ckpt", "*.ttf", "*.otf", "*.woff", "*.woff2", "*.iso", "*.dmg", "*.img", "*.vhd", "*.vhdx"];
const FILTERED_NAME = new RegExp(`\\.(${FILTERED.map(pattern => pattern.slice(2)).join("|")})$`, "i");
export const filtered = (path: string) => FILTERED_NAME.test(path);

/** A1 references in a formula, made relative to the formula's own cell; reversible for any formula text. */
const REFERENCE = /(\$?)([A-Z]{1,3})(\$?)([1-9]\d{0,6})(?!\d)/g;
function relative(formula: string, column: number, row: number): string | [string] {
	if (/[\x01\x02]/.test(formula)) return [formula];
	return formula.replace(REFERENCE, (_match, fixedColumn: string, letters: string, fixedRow: string, digits: string) => {
		const [c, r] = cellPosition(letters + digits);
		return `\x01${fixedColumn ? `=${c}` : c - column},${fixedRow ? `=${r}` : r - row}\x02`;
	});
}
function absolute(value: string | [string], column: number, row: number): string {
	if (Array.isArray(value)) return value[0];
	return value.replace(/\x01(=?)(-?\d+),(=?)(-?\d+)\x02/g, (_match, fixedColumn: string, c: string, fixedRow: string, r: string) =>
		`${fixedColumn ? "$" : ""}${columnName(fixedColumn ? Number(c) : column + Number(c))}${fixedRow ? "$" : ""}${(fixedRow ? Number(r) : row + Number(r)) + 1}`);
}

export function encodeDocument(document: OfficeDocument): Buffer {
	const lines = [`${OFFICE_HEADER}${document.kind}`];
	if (document.kind === "docx") for (const paragraph of document.paragraphs) lines.push(JSON.stringify(paragraph));
	else if (document.kind === "pptx") for (const slide of document.slides) lines.push(JSON.stringify(slide));
	else for (const sheet of document.sheets) {
		lines.push(JSON.stringify({ sheet: sheet.name }));
		const cells = [...sheet.cells].map(([ref, cell]) => { const [column, row] = cellPosition(ref); return { column, row, cell }; })
			.sort((a, b) => a.column - b.column || a.row - b.row);
		let column = -1, row = -1;
		for (const item of cells) {
			// Positions as steps from the previous cell: down a column that is mostly [0, 1].
			const step = [item.column - column, item.row - (item.column === column ? row : -1)];
			lines.push(JSON.stringify(item.cell.formula === undefined ? [...step, item.cell.value] : [...step, item.cell.value, relative(item.cell.formula, item.column, item.row)]));
			column = item.column; row = item.row;
		}
	}
	return Buffer.from(`${lines.join("\n")}\n`);
}
function decodeDocument(text: string): OfficeDocument {
	const [header, ...lines] = text.split("\n").filter(Boolean);
	const kind = header!.slice(OFFICE_HEADER.length) as OfficeDocument["kind"];
	if (kind === "docx") return { kind, paragraphs: lines.map(line => JSON.parse(line) as string) };
	if (kind === "pptx") return { kind, slides: lines.map(line => JSON.parse(line) as string[]) };
	const sheets: { name: string; cells: Map<string, Cell> }[] = [];
	let column = -1, row = -1;
	for (const line of lines) {
		const value = JSON.parse(line) as { sheet: string } | [number, number, string, (string | [string])?];
		if (!Array.isArray(value)) { sheets.push({ name: value.sheet, cells: new Map() }); column = -1; row = -1; continue; }
		const next = column + value[0];
		row = (next === column ? row : -1) + value[1]; column = next;
		sheets.at(-1)!.cells.set(`${columnName(column)}${row + 1}`, value[3] === undefined ? { value: value[2] } : { value: value[2], formula: absolute(value[3], column, row) });
	}
	return { kind, sheets };
}

function fingerprint(data: Buffer): Buffer {
	return Buffer.from(`${FILE_HEADER}${data.length}\n${createHash("sha256").update(data).digest("hex")}\n`);
}
/** What is stored for a filtered file. Never throws: a file that cannot be read is fingerprinted. */
export function encodeContent(path: string, data: Buffer): Buffer {
	const kind = officeKind(path);
	if (kind && data.length <= OFFICE_LIMIT && data[0] === 0x50 && data[1] === 0x4b) {
		try { return encodeDocument(readOffice(data, kind)); } catch { /* Fingerprinted below. */ }
	}
	return fingerprint(data);
}

export type Version = { type: "office"; document: OfficeDocument } | { type: "file"; size: number; hash: string } | { type: "text"; data: Buffer };
const textual = (data: Buffer) => !data.subarray(0, 8192).includes(0);
/** A stored version, or a file's own bytes, read back as a document, a fingerprint or text. */
export function readVersion(data: Buffer, path: string): Version {
	if (data.subarray(0, OFFICE_HEADER.length).toString("latin1") === OFFICE_HEADER) return { type: "office", document: decodeDocument(data.toString("utf8")) };
	if (data.subarray(0, FILE_HEADER.length).toString("latin1") === FILE_HEADER) {
		const [, size, hash] = data.toString("latin1").split("\n");
		return { type: "file", size: Number(size), hash: hash! };
	}
	const kind = OFFICE.test(path) ? officeKind(path) : undefined;
	if (kind && data[0] === 0x50 && data[1] === 0x4b) try { return { type: "office", document: readOffice(data, kind) }; } catch { /* A binary file below. */ }
	if (!textual(data) || filtered(path)) return { type: "file", size: data.length, hash: createHash("sha256").update(data).digest("hex") };
	return { type: "text", data };
}
