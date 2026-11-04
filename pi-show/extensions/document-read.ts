import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { detectSupportedImageMimeTypeFromFile, type ReadOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { officePdf, OFFICE_PAGES } from "../../pi-desk/src/host/office-pages.ts";
import { docxText, pdfPage, pdfText, pptxText, xlsxText } from "./document-text.ts";
import { officeKind } from "./documents.ts";

const PDF = /\.pdf$/i;

/** Pi's read parameters, and page. */
export const ReadParameters = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	page: Type.Optional(Type.Integer({ minimum: 1, description: "PDF and Office files: this page (from 1) as an image, to see how it looks" })),
});
/** What read's description adds for documents. */
export const READ_DOCUMENTS = "PDF and Office files (Word, Excel, PowerPoint) are read as text: sheets as cells with their formulas, slides with their notes, PDFs by page. page gives one page of a PDF or Office file as an image, to check how it looks.";

/** The file's version as Desk's file view makes it (pi-desk local-files.ts), so both use one converted PDF. */
async function version(path: string): Promise<string> {
	const info = await stat(path, { bigint: true });
	return createHash("sha256").update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`).digest("hex");
}
/** A PDF of the file's pages: the file itself, or what the Office suite on this computer makes of it. */
async function pages(path: string): Promise<Buffer> {
	return readFile(PDF.test(path) ? path : await officePdf(path, await version(path)));
}

/** The text last read from a document, kept while the file is unchanged: read takes a long one a page per call. */
let last: { key: string; text: Promise<Buffer> } | undefined;
async function documentText(path: string, make: (data: Buffer) => Buffer | Promise<Buffer>): Promise<Buffer> {
	const key = `${path}\0${await version(path)}`;
	if (last?.key !== key) {
		const text = readFile(path).then(make);
		last = { key, text };
		text.catch(() => { if (last?.text === text) last = undefined; });
	}
	return last.text;
}

/**
 * The file operations of Pi's read, with PDF and Office files read as text: Word paragraphs and tables, sheets as cells
 * with their formulas, slides with their notes, PDF text by page. Files of older formats (.doc, .xls, .ppt and
 * OpenDocument) are read from the pages the Office suite makes of them. `page` gives one page as an image. Paging,
 * truncation and image sizing stay Pi's.
 */
export function documentOperations(page: number | undefined): ReadOperations {
	return {
		access: path => access(path, constants.R_OK),
		detectImageMimeType: async path => {
			if (page === undefined) return detectSupportedImageMimeTypeFromFile(path);
			if (!PDF.test(path) && !OFFICE_PAGES.test(path)) throw new Error("page applies to PDF and Office files; read this file without it.");
			return "image/png";
		},
		readFile: async path => {
			if (page !== undefined) return pdfPage(await pages(path), page);
			const kind = officeKind(path);
			if (kind) return documentText(path, data => Buffer.from(kind === "docx" ? docxText(data) : kind === "pptx" ? pptxText(data) : xlsxText(data)));
			if (PDF.test(path)) return documentText(path, async data => Buffer.from(await pdfText(data)));
			if (OFFICE_PAGES.test(path)) return documentText(path, async () => Buffer.from(`(The text of the pages the Office suite made of this file.)\n\n${await pdfText(await pages(path))}`));
			return readFile(path);
		},
	};
}
