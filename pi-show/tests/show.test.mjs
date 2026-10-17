import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { diffOffice, previewOffice, readOffice, unlistedCells } from "../extensions/documents.ts";
import { diffSequences, lineDiff } from "../extensions/sequence-diff.ts";
import show, { mentionedDocuments } from "../extensions/show.ts";

/** A zip of the given files, deflated, as Office writes them. */
function zip(files) {
	const locals = [], central = [];
	let offset = 0;
	for (const [name, text] of Object.entries(files)) {
		const data = Buffer.from(text), packed = deflateRawSync(data), title = Buffer.from(name);
		const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
		local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(title.length, 26);
		const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(8, 10);
		entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(title.length, 28); entry.writeUInt32LE(offset, 42);
		locals.push(local, title, packed); central.push(entry, title);
		offset += 30 + title.length + packed.length;
	}
	const directory = Buffer.concat(central), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
	end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}
const workbook = (sheets, strings) => zip({
	"xl/workbook.xml": `<workbook><sheets>${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`,
	"xl/_rels/workbook.xml.rels": `<Relationships>${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="x" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`,
	"xl/sharedStrings.xml": `<sst>${strings.map(text => `<si><t>${text}</t></si>`).join("")}</sst>`,
	...Object.fromEntries(sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, `<worksheet><sheetData><row>${sheet.cells}</row></sheetData></worksheet>`])),
});
const document = paragraphs => zip({ "word/document.xml": `<w:document><w:body>${paragraphs.map(text => `<w:p><w:pPr><w:tabs><w:tab w:val="left"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join("")}</w:body></w:document>` });

test("spreadsheet changes are computed cell by cell, with formulas, and checked against the agent's own list", () => {
	const before = workbook([{ name: "Totals", cells: `<c r="A1" t="s"><v>0</v></c><c r="B2"><v>1200</v></c><c r="B3"><f>B2*2</f><v>2400</v></c>` },
		{ name: "Notes", cells: `<c r="A1" t="inlineStr"><is><t>Draft &amp; unchecked</t></is></c>` }], ["Client"]);
	const after = workbook([{ name: "Totals", cells: `<c r="A1" t="s"><v>0</v></c><c r="B2"><v>1350</v></c><c r="B3"><f>B2*3</f><v>4050</v></c><c r="C9" t="b"><v>1</v></c>` },
		{ name: "Notes", cells: `<c r="A1" t="inlineStr"><is><t>Draft &amp; unchecked</t></is></c>` }], ["Client"]);
	const old = readOffice(before, "xlsx");
	assert.equal(old.sheets[1].cells.get("A1").value, "Draft & unchecked");
	const changes = diffOffice(old, readOffice(after, "xlsx"));
	assert.equal(changes.summary, "3 cells changed in Totals");
	assert.deepEqual(changes.cells, [
		{ sheet: "Totals", cell: "B2", before: "1200", after: "1350" },
		{ sheet: "Totals", cell: "B3", before: "2400", after: "4050", formulaBefore: "B2*2", formulaAfter: "B2*3" },
		{ sheet: "Totals", cell: "C9", after: "TRUE" },
	]);
	assert.deepEqual(unlistedCells(changes, ["Totals!B2:B3"]).map(cell => cell.cell), ["C9"]);
	assert.deepEqual(unlistedCells(changes, ["Notes!B2", "C9"]).map(cell => cell.cell), ["B2", "B3"]);
	const preview = previewOffice(readOffice(after, "xlsx"), "Totals!A1:C3");
	assert.deepEqual(preview.rows.map(row => row.map(cell => cell.value)), [["Client", "", ""], ["", "1350", ""], ["", "4050", ""]]);
	assert.equal(preview.rows[2][1].formula, "B2*3");
});

test("document changes are computed paragraph by paragraph, folding unchanged ones", () => {
	const paragraphs = ["Title", "One", "Two", "Three", "Four", "Five", "Six"];
	const changes = diffOffice(readOffice(document(paragraphs), "docx"),
		readOffice(document(["Title", "One", "Two", "Three", "Four & more", "Five", "Six", "Seven"]), "docx"));
	assert.equal(changes.summary, "1 paragraph changed, 1 added");
	assert.deepEqual(changes.paragraphs, [{ op: "gap", count: 3 }, { op: "=", text: "Three" }, { op: "-", text: "Four" }, { op: "+", text: "Four & more" },
		{ op: "=", text: "Five" }, { op: "=", text: "Six" }, { op: "+", text: "Seven" }]);
	assert.equal(diffOffice(readOffice(document(paragraphs), "docx"), readOffice(document(paragraphs), "docx")), undefined);
});

test("sequence diffs are minimal", () => {
	const lcs = (a, b) => { const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
		for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
		return t[0][0]; };
	let seed = 7;
	const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	for (let round = 0; round < 300; round++) {
		const a = Array.from({ length: Math.floor(random() * 12) }, () => "abc"[Math.floor(random() * 3)]);
		const b = Array.from({ length: Math.floor(random() * 12) }, () => "abc"[Math.floor(random() * 3)]);
		const ops = diffSequences(a, b);
		assert.equal(ops.filter(op => op.op === "=").length, lcs(a, b));
		assert.deepEqual(ops.filter(op => op.op !== "+").map(op => a[op.a]), a);
		assert.deepEqual(ops.filter(op => op.op !== "-").map(op => b[op.b]), b);
	}
	assert.equal(lineDiff("a\nb\nc\n", "a\nB\nc\n").text, " 1 a\n-2 b\n+2 B\n 3 c\n 4 ");
});

test("Office files named in commands and in the scripts they run are found", () => {
	const scripts = { "/work/fix.py": "wb = load_workbook('Budget FY26.xlsx')" };
	assert.deepEqual(mentionedDocuments(`cd /work && python3 fix.py && libreoffice --convert-to pdf "Report final.docx"`, "/home", path => scripts[path]),
		["/work/Report final.docx", "/work/Budget FY26.xlsx"]);
	assert.deepEqual(mentionedDocuments("python3 - <<'EOF'\nload_workbook('/data/a.xlsm')\nEOF", "/home"), ["/data/a.xlsm"]);
});

test("tool results gain computed changes, and show reports them with what the agent left out", async t => {
	const directory = mkdtempSync(join(tmpdir(), "pi-show-")), prior = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
	t.after(() => { rmSync(directory, { recursive: true, force: true }); if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; });
	const handlers = {}, tools = {};
	show({ on: (name, handler) => { handlers[name] = handler; }, registerTool: tool => { tools[tool.name] = tool; } });
	const ctx = { cwd: directory, sessionManager: { getSessionId: () => "session-1" } };
	const book = join(directory, "Budget.xlsx"), notes = join(directory, "notes.md");
	writeFileSync(book, workbook([{ name: "Totals", cells: `<c r="B2"><v>1200</v></c>` }], []));
	writeFileSync(notes, "# Notes\nfirst\n");

	await handlers.tool_call({ toolName: "bash", toolCallId: "1", input: { command: "python3 update.py Budget.xlsx" } }, ctx);
	writeFileSync(book, workbook([{ name: "Totals", cells: `<c r="B2"><v>1350</v></c><c r="B7"><v>9</v></c>` }], []));
	const result = await handlers.tool_result({ toolName: "bash", toolCallId: "1", input: {}, content: [], details: { exitCode: 0 } });
	assert.equal(result.details.exitCode, 0);
	assert.equal(result.details.documentChanges[0].summary, "2 cells changed in Totals");

	await handlers.tool_call({ toolName: "write", toolCallId: "2", input: { path: "notes.md" } }, ctx);
	writeFileSync(notes, "# Notes\nsecond\n");
	const written = await handlers.tool_result({ toolName: "write", toolCallId: "2", input: {}, content: [] });
	assert.equal(written.details.diff, " 1 # Notes\n-2 first\n+2 second\n 3 ");
	assert.equal(written.details.path, notes);
	assert.equal(await handlers.tool_result({ toolName: "bash", toolCallId: "3", input: {}, content: [] }), undefined, "untracked calls are left alone");

	const shown = await tools.show.execute("4", { title: "Budget update", items: [{ file: "Budget.xlsx", changes: [{ where: "Totals!B2", before: "1200", after: "1350" }] }, { file: "notes.md" }, { file: "missing.png" }] }, undefined, undefined, ctx);
	assert.match(shown.content[0].text, /Desk found 1 changed cell you did not list \(Totals!B7\)/);
	assert.match(shown.content[0].text, /missing\.png was not found/);
	const [sheet, text, missing] = shown.details.show.items;
	assert.equal(sheet.changes.total, 2);
	assert.deepEqual(sheet.unlisted, { count: 1, examples: ["Totals!B7"] });
	assert.match(text.diff.text, /\+2 second/);
	assert.equal(missing.missing, true);
	assert.ok(readFileSync(join(directory, "agent", "show", "session-1", "index.json"), "utf8").includes("Budget.xlsx"));
});
