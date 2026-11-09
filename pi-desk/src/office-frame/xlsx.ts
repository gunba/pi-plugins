import JSZip from "jszip";
import { fitWidth, officeFrame } from "./frame.ts";

/** Rows and columns drawn per sheet: enough to read a workpaper, bounded so a large export stays quick. */
const ROWS = 300, COLUMNS = 40;
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

interface Style { format: string; bold?: boolean; italic?: boolean; color?: string; fill?: string; align?: string }
interface Cell { text: string; style?: Style; number: boolean }

/** A spreadsheet's sheets, one under another, each as a grid of its cells with their values formatted as Excel shows them. */
officeFrame(async (bytes, root) => {
	const zip = await JSZip.loadAsync(bytes);
	const xml = async (path: string) => { const file = zip.file(path); return file ? new DOMParser().parseFromString(await file.async("string"), "application/xml") : undefined; };
	const workbook = await xml("xl/workbook.xml");
	if (!workbook) throw new Error("This file has no workbook.");
	const links = new Map([...(await xml("xl/_rels/workbook.xml.rels"))?.getElementsByTagName("Relationship") ?? []]
		.map(link => [link.getAttribute("Id"), link.getAttribute("Target") ?? ""]));
	const date1904 = workbook.getElementsByTagNameNS(MAIN, "workbookPr")[0]?.getAttribute("date1904") === "1";
	const strings = [...(await xml("xl/sharedStrings.xml"))?.getElementsByTagNameNS(MAIN, "si") ?? []].map(text);
	const styles = readStyles(await xml("xl/styles.xml"));
	for (const sheet of workbook.getElementsByTagNameNS(MAIN, "sheet")) {
		if (sheet.getAttribute("state") === "hidden" || sheet.getAttribute("state") === "veryHidden") continue;
		const target = links.get(sheet.getAttributeNS(RELATIONSHIPS, "id") ?? sheet.getAttribute("r:id")) ?? "";
		const document = await xml(target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, ""));
		if (!document) continue;
		const heading = root.appendChild(window.document.createElement("h2"));
		heading.textContent = sheet.getAttribute("name") ?? "Sheet";
		const drawn = root.appendChild(drawSheet(document, strings, styles, date1904));
		// A wide sheet is shrunk to the frame, to half size at most; beyond that its right side is cut off.
		fitWidth(drawn, () => drawn.querySelector("table")!.offsetWidth, 0.5);
	}
});

function text(node: Element): string {
	// Phonetic hints (rPh) are not part of the text.
	return [...node.getElementsByTagNameNS(MAIN, "t")].filter(t => t.parentElement?.localName !== "rPh").map(t => t.textContent ?? "").join("");
}

const BUILT_IN: Record<number, string> = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00",
	12: "# ?/?", 13: "# ??/??", 14: "d/mm/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm",
	21: "h:mm:ss", 22: "d/mm/yyyy h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
	45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@" };

function readStyles(document: Document | undefined): Style[] {
	if (!document) return [];
	const formats = new Map([...document.getElementsByTagNameNS(MAIN, "numFmt")].map(format => [Number(format.getAttribute("numFmtId")), format.getAttribute("formatCode") ?? "General"]));
	const color = (node: Element | undefined) => { const rgb = node?.getAttribute("rgb"); return rgb && /^[0-9A-F]{8}$/i.test(rgb) ? "#" + rgb.slice(2) : undefined; };
	const fonts = [...document.getElementsByTagNameNS(MAIN, "fonts")[0]?.getElementsByTagNameNS(MAIN, "font") ?? []].map(font => ({
		bold: !!font.getElementsByTagNameNS(MAIN, "b")[0] && font.getElementsByTagNameNS(MAIN, "b")[0]!.getAttribute("val") !== "0",
		italic: !!font.getElementsByTagNameNS(MAIN, "i")[0] && font.getElementsByTagNameNS(MAIN, "i")[0]!.getAttribute("val") !== "0",
		color: color(font.getElementsByTagNameNS(MAIN, "color")[0]) }));
	const fills = [...document.getElementsByTagNameNS(MAIN, "fills")[0]?.getElementsByTagNameNS(MAIN, "fill") ?? []].map(fill => {
		const pattern = fill.getElementsByTagNameNS(MAIN, "patternFill")[0];
		return pattern?.getAttribute("patternType") === "solid" ? color(pattern.getElementsByTagNameNS(MAIN, "fgColor")[0]) : undefined;
	});
	return [...document.getElementsByTagNameNS(MAIN, "cellXfs")[0]?.getElementsByTagNameNS(MAIN, "xf") ?? []].map(xf => {
		const id = Number(xf.getAttribute("numFmtId") ?? 0), font = fonts[Number(xf.getAttribute("fontId") ?? 0)];
		return { format: formats.get(id) ?? BUILT_IN[id] ?? "General", bold: font?.bold, italic: font?.italic, color: font?.color,
			fill: fills[Number(xf.getAttribute("fillId") ?? 0)], align: xf.getElementsByTagNameNS(MAIN, "alignment")[0]?.getAttribute("horizontal") ?? undefined };
	});
}

/** Column letters to a zero-based index: A is 0, AA is 26. */
const column = (letters: string) => [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
const letters = (index: number): string => (index >= 26 ? letters(Math.floor(index / 26) - 1) : "") + String.fromCharCode(65 + index % 26);

function drawSheet(document: Document, strings: string[], styles: Style[], date1904: boolean): HTMLElement {
	const cells = new Map<string, Cell>();
	let rows = 0, columns = 0, more = false;
	for (const node of document.getElementsByTagNameNS(MAIN, "c")) {
		const at = /^([A-Z]+)(\d+)$/.exec(node.getAttribute("r") ?? "");
		if (!at) continue;
		const x = column(at[1]!), y = Number(at[2]) - 1;
		if (y >= ROWS || x >= COLUMNS) { more = true; continue; }
		const style = styles[Number(node.getAttribute("s") ?? 0)];
		const type = node.getAttribute("t"), value = node.getElementsByTagNameNS(MAIN, "v")[0]?.textContent ?? "";
		let cell: Cell;
		if (type === "s") cell = { text: strings[Number(value)] ?? "", style, number: false };
		else if (type === "inlineStr") cell = { text: text(node), style, number: false };
		else if (type === "b") cell = { text: value === "1" ? "TRUE" : "FALSE", style, number: false };
		else if (type === "str" || type === "e" || type === "d") cell = { text: value, style, number: false };
		else if (value === "") cell = { text: "", style, number: false };
		else cell = { text: formatNumber(Number(value), style?.format ?? "General", date1904), style, number: true };
		if (!cell.text && !cell.style?.fill) continue;
		cells.set(x + ":" + y, cell);
		rows = Math.max(rows, y + 1); columns = Math.max(columns, x + 1);
	}
	const merged = new Map<string, { rows: number; columns: number }>(), covered = new Set<string>();
	for (const merge of document.getElementsByTagNameNS(MAIN, "mergeCell")) {
		const range = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(merge.getAttribute("ref") ?? "");
		if (!range) continue;
		const [x1, y1, x2, y2] = [column(range[1]!), Number(range[2]) - 1, column(range[3]!), Number(range[4]) - 1];
		merged.set(x1 + ":" + y1, { rows: y2 - y1 + 1, columns: x2 - x1 + 1 });
		for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) if (x !== x1 || y !== y1) covered.add(x + ":" + y);
	}
	const widths: number[] = [];
	for (const col of document.getElementsByTagNameNS(MAIN, "col")) {
		const width = Number(col.getAttribute("width"));
		// A very wide column, often one holding instructions, is narrowed so the sheet isn't shrunk to fit it.
		if (width) for (let x = Number(col.getAttribute("min")) - 1; x < Math.min(COLUMNS, Number(col.getAttribute("max"))); x++) widths[x] = Math.min(320, Math.round(width * 7 + 5));
	}
	const table = window.document.createElement("table");
	const head = table.createTHead().insertRow();
	head.appendChild(window.document.createElement("th"));
	const group = table.insertBefore(window.document.createElement("colgroup"), table.firstChild);
	group.appendChild(window.document.createElement("col")).style.width = "36px";
	for (let x = 0; x < columns; x++) {
		head.appendChild(window.document.createElement("th")).textContent = letters(x);
		group.appendChild(window.document.createElement("col")).style.width = (widths[x] ?? 64) + "px";
	}
	// A fixed layout needs the table's width set; otherwise long text widens its column past the sheet's width.
	table.style.width = 36 + Array.from({ length: columns }, (_, x) => widths[x] ?? 64).reduce((total, width) => total + width, 0) + "px";
	const body = table.createTBody();
	for (let y = 0; y < rows; y++) {
		const row = body.insertRow();
		row.appendChild(window.document.createElement("th")).textContent = String(y + 1);
		for (let x = 0; x < columns; x++) {
			const key = x + ":" + y;
			if (covered.has(key)) continue;
			const cell = cells.get(key), td = row.insertCell(), span = merged.get(key);
			if (span) { td.rowSpan = Math.min(span.rows, rows - y); td.colSpan = Math.min(span.columns, columns - x); }
			if (!cell) continue;
			td.textContent = cell.text;
			const style = cell.style;
			if (style?.bold) td.style.fontWeight = "600";
			if (style?.italic) td.style.fontStyle = "italic";
			if (style?.color) td.style.color = style.color;
			if (style?.fill) td.style.background = style.fill;
			td.style.textAlign = style?.align && style.align !== "general" ? style.align.replace("centerContinuous", "center") : cell.number ? "right" : "left";
		}
	}
	const sheet = window.document.createElement("div");
	sheet.className = "sheet";
	sheet.appendChild(table);
	if (more) sheet.appendChild(window.document.createElement("p")).textContent = "Showing the first " + ROWS + " rows and " + COLUMNS + " columns.";
	return sheet;
}

/** The format section for a value: positive, negative, zero, as Excel picks them; quoted text and escapes kept whole. */
function sections(format: string): string[] {
	const parts: string[] = [];
	let current = "", quoted = false;
	for (let index = 0; index < format.length; index++) {
		const char = format[index]!;
		if (char === '"') quoted = !quoted;
		if (char === "\\" && !quoted) { current += char + (format[++index] ?? ""); continue; }
		if (char === ";" && !quoted) { parts.push(current); current = ""; continue; }
		current += char;
	}
	return [...parts, current];
}

/** A number as Excel shows it under a format code: numbers, percentages, currency, scientific notation, dates and times. */
export function formatNumber(value: number, format: string, date1904 = false): string {
	if (!Number.isFinite(value)) return String(value);
	const parts = sections(format);
	let section = parts[0]!, sign = value < 0 ? "-" : "";
	if (value < 0 && parts.length > 1) { section = parts[1]!; sign = ""; }
	else if (value === 0 && parts.length > 2) section = parts[2]!;
	// Colours and conditions are dropped; a currency tag keeps its symbol.
	section = section.replace(/\[\$([^\]-]*)(?:-[^\]]*)?\]/g, (_, symbol: string) => symbol ? '"' + symbol + '"' : "").replace(/\[(?![hms]+\])[^\]]*\]/gi, "");
	if (/^general$/i.test(section.trim()) || section.trim() === "") return sign + general(Math.abs(value));
	if (section.trim() === "@") return sign + general(Math.abs(value));
	const bare = section.replace(/"[^"]*"|\\./g, "");
	if (/[dmyhs]/i.test(bare.replace(/E[+-]/gi, ""))) return formatDate(value, section, date1904);
	const absolute = Math.abs(value) * (bare.includes("%") ? 100 : 1);
	// The literal text before the first digit placeholder and after the last stays as written.
	let text = "", out = "";
	const placeholder = /[0#?.,E]/;
	let start = -1, end = -1;
	for (let index = 0; index < section.length; index++) {
		const char = section[index]!;
		if (char === '"') { const close = section.indexOf('"', index + 1); index = close < 0 ? section.length : close; continue; }
		if (char === "\\") { index++; continue; }
		if (placeholder.test(char) && !(char === "E" && !/[0#]/.test(section.slice(0, index)))) { if (start < 0) start = index; end = index; }
	}
	const literal = (part: string) => part.replace(/"([^"]*)"|\\(.)|_.|\*./g, (_, quoted?: string, escaped?: string) => quoted ?? escaped ?? (_.startsWith("_") ? " " : ""));
	if (start < 0) return literal(section);
	const pattern = section.slice(start, end + 1);
	const decimals = (/\.([0#?]*)/.exec(pattern)?.[1] ?? "").length, grouping = /[0#?],[0#?]/.test(pattern);
	if (/E[+-]/i.test(pattern)) out = absolute.toExponential(decimals).replace("e", "E").replace(/E([+-])(\d)$/, "E$10$2");
	else {
		// Trailing commas divide by a thousand each.
		const scaled = absolute / 1000 ** (/,+$/.exec(pattern.replace(/[^0#?,]/g, ""))?.[0].length ?? 0);
		out = scaled.toLocaleString("en-AU", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouping });
		if (/^#/.test(pattern.replace(/,/g, "")) && out.startsWith("0") && Math.abs(scaled) < 1 && decimals) out = out.slice(1);
	}
	text = literal(section.slice(0, start)) + out + literal(section.slice(end + 1));
	return sign + text;
}

function general(value: number): string {
	if (value !== 0 && (Math.abs(value) >= 1e11 || Math.abs(value) < 1e-9)) return value.toExponential(5).replace(/\.?0+e/, "E").replace("e", "E");
	return String(Number(value.toPrecision(11)));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDate(serial: number, section: string, date1904: boolean): string {
	// Excel counts days from 1900-01-00 (keeping 1900's false leap day) or from 1904-01-01.
	const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
	const date = new Date(epoch + Math.round(serial * 86_400_000));
	const twelve = /AM\/PM|A\/P/i.test(section);
	const tokens = /"[^"]*"|\\.|\[h+\]|\[m+\]|\[s+\]|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P|\.0+|_.|\*./gi;
	const found = [...section.matchAll(tokens)];
	// m is minutes right after an hour or right before a second, and the month otherwise.
	const units = found.map(match => /^["\\_*]/.test(match[0]) ? "" : match[0].toLowerCase());
	const minute = (index: number) => /^\[?h/.test(units.slice(0, index).filter(Boolean).at(-1) ?? "") || /^\[?s/.test(units.slice(index + 1).find(Boolean) ?? "");
	let out = "", last = 0;
	found.forEach((match, index) => {
		out += section.slice(last, match.index);
		last = match.index! + match[0].length;
		const token = match[0], lower = token.toLowerCase();
		const hours = date.getUTCHours(), minutes = date.getUTCMinutes(), seconds = date.getUTCSeconds();
		if (token.startsWith('"')) out += token.slice(1, -1);
		else if (token.startsWith("\\")) out += token.slice(1);
		else if (token.startsWith("_")) out += " ";
		else if (token.startsWith("*")) out += "";
		else if (lower.startsWith("[h")) out += String(Math.floor(serial * 24));
		else if (lower.startsWith("[m")) out += String(Math.floor(serial * 1440));
		else if (lower.startsWith("[s")) out += String(Math.floor(serial * 86400));
		else if (lower === "yyyy") out += date.getUTCFullYear();
		else if (lower === "yy") out += String(date.getUTCFullYear()).slice(-2);
		else if (lower === "mmmmm") out += MONTHS[date.getUTCMonth()]![0];
		else if (lower === "mmmm") out += MONTHS[date.getUTCMonth()];
		else if (lower === "mmm") out += MONTHS[date.getUTCMonth()]!.slice(0, 3);
		else if (lower === "mm" || lower === "m") {
			const value = minute(index) ? minutes : date.getUTCMonth() + 1;
			out += lower === "mm" ? String(value).padStart(2, "0") : value;
		}
		else if (lower === "dddd") out += DAYS[date.getUTCDay()];
		else if (lower === "ddd") out += DAYS[date.getUTCDay()]!.slice(0, 3);
		else if (lower === "dd") out += String(date.getUTCDate()).padStart(2, "0");
		else if (lower === "d") out += date.getUTCDate();
		else if (lower === "hh" || lower === "h") { const hour = twelve ? (hours % 12 || 12) : hours; out += lower === "hh" ? String(hour).padStart(2, "0") : hour; }
		else if (lower === "ss" || lower === "s") out += lower === "ss" ? String(seconds).padStart(2, "0") : seconds;
		else if (lower === "am/pm") out += hours < 12 ? "AM" : "PM";
		else if (lower === "a/p") out += hours < 12 ? "A" : "P";
		else if (lower.startsWith(".0")) out += (date.getUTCMilliseconds() / 1000).toFixed(lower.length - 1).slice(1);
	});
	return out + section.slice(last);
}
