import assert from "node:assert/strict";
import test from "node:test";
import { encodeContent, encodeDocument, readVersion } from "../extensions/content.ts";
import { readOffice } from "../extensions/documents.ts";
import { document, workbook } from "./fixtures.mjs";

test("Office documents are kept as their content and read back exactly, formulas included", () => {
	// Desk keeps a document's content instead of the file; it must read back as the same document.
	const formulas = ["B2*2", "SUM($B$2:B9)", "Ledger!$C4+D$5", "LOG10(A1)", "TEXT(A1,\"A007\")", "IF(A1>0,\"ZZZ9999999\",\"\")", "\u0001odd\u0002", "A1048576"];
	const cells = formulas.map((formula, index) => `<c r="${["C", "D", "AA", "XFD"][index % 4]}${index + 3}"><f>${formula.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll(">", "&gt;")}</f><v>${index}</v></c>`).join("");
	const original = readOffice(workbook([{ name: "Totals", cells: `<c r="A1" t="s"><v>0</v></c><c r="B2"><v>1200</v></c>${cells}` },
		{ name: "Notes \"draft\"", cells: `<c r="A1" t="inlineStr"><is><t>Line one\tand two</t></is></c>` }], ["Client"]), "xlsx");
	assert.deepEqual(readVersion(encodeDocument(original), "Budget.xlsx"), { type: "office", document: original });
	const words = readOffice(document(["Opening", "", "Closing \u201cquoted\u201d"]), "docx");
	assert.deepEqual(readVersion(encodeContent("Letter.docx", document(["Opening", "", "Closing \u201cquoted\u201d"])), "Letter.docx"), { type: "office", document: words });
});

test("binary files are kept as a fingerprint, and a damaged Office file is fingerprinted rather than failing", () => {
	const image = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(50_000, 7)]);
	const kept = encodeContent("logo.png", image);
	assert.ok(kept.length < 200);
	assert.deepEqual(readVersion(kept, "logo.png"), readVersion(image, "logo.png"), "a fingerprint and the file it came from compare equal");
	assert.equal(readVersion(encodeContent("Broken.xlsx", Buffer.from("PK not really a zip")), "Broken.xlsx").type, "file");
});
