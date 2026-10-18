import { deflateRawSync } from "node:zlib";

/** A zip of the given files, deflated, as Office writes them. */
export function zip(files) {
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
export const workbook = (sheets, strings) => zip({
	"xl/workbook.xml": `<workbook><sheets>${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`,
	"xl/_rels/workbook.xml.rels": `<Relationships>${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="x" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}</Relationships>`,
	"xl/sharedStrings.xml": `<sst>${strings.map(text => `<si><t>${text}</t></si>`).join("")}</sst>`,
	...Object.fromEntries(sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, `<worksheet><sheetData><row>${sheet.cells}</row></sheetData></worksheet>`])),
});
export const document = paragraphs => zip({ "word/document.xml": `<w:document><w:body>${paragraphs.map(text => `<w:p><w:pPr><w:tabs><w:tab w:val="left"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`).join("")}</w:body></w:document>` });
