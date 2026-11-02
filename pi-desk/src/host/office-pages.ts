import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export { OFFICE_PAGES } from "../shared/files.ts";

const KEEP = 200, TIMEOUT = 50_000;

/**
 * The file's pages as a PDF, made by the Office suite on this computer: Microsoft Office on Windows, LibreOffice
 * elsewhere. Kept by file version under the agent directory, so a file is converted once while it is unchanged.
 * Spreadsheets are fitted one page wide, so a sheet reads as one sheet rather than as printed strips.
 */
export async function officePdf(path: string, version: string): Promise<string> {
	const cache = join(getAgentDir(), "cache", "office-pages"), pdf = join(cache, version + ".pdf");
	if (existsSync(pdf)) { const now = new Date(); utimesSync(pdf, now, now); return pdf; }
	mkdirSync(cache, { recursive: true });
	const work = mkdtempSync(join(tmpdir(), "desk-office-"));
	try {
		const source = join(work, "document" + extname(path).toLowerCase()), output = join(work, "document.pdf");
		copyFileSync(path, source);
		if (process.platform === "win32") await windowsPdf(source, output, work);
		else await run("soffice", ["-env:UserInstallation=file://" + join(work, "profile"), "--headless", "--norestore", "--convert-to",
			/\.(xlsx|xlsm|xls|ods)$/i.test(source) ? 'pdf:calc_pdf_Export:{"SinglePageSheets":{"type":"boolean","value":"true"}}' : "pdf", "--outdir", work, source],
			"Showing Office files as pages needs LibreOffice on this computer (the soffice command).");
		if (!existsSync(output)) throw new Error("The Office suite made no pages from this file.");
		renameSync(output, pdf);
		prune(cache);
		return pdf;
	} finally { rmSync(work, { recursive: true, force: true }); }
}

function run(command: string, args: string[], missing: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
		let errors = "";
		const timer = setTimeout(() => { child.kill(); reject(new Error("The Office suite took too long to render this file.")); }, TIMEOUT);
		child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
		child.on("error", error => { clearTimeout(timer); reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(missing) : error); });
		child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("The Office suite could not render this file: " + (errors.trim() || "exit " + code))); });
	});
}

/**
 * Word, Excel or PowerPoint through their automation interface, opening a copy read-only and without a window. PowerPoint
 * runs one instance, which may be Jordan's own with his decks open, so each application quits only when it holds nothing.
 */
function windowsPdf(source: string, output: string, work: string): Promise<void> {
	const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
	const kind = /\.(xlsx|xlsm|xls|ods)$/i.test(source) ? "excel" : /\.(pptx|pptm|ppt|odp)$/i.test(source) ? "powerpoint" : "word";
	const script = `$ErrorActionPreference = 'Stop'
$source = ${quote(source)}; $output = ${quote(output)}
switch ('${kind}') {
  'word' { $app = New-Object -ComObject Word.Application; $app.Visible = $false; $app.DisplayAlerts = 0
    try { $doc = $app.Documents.Open($source, $false, $true, $false); $doc.ExportAsFixedFormat($output, 17); $doc.Close($false) } finally { if ($app.Documents.Count -eq 0) { $app.Quit() } } }
  'excel' { $app = New-Object -ComObject Excel.Application; $app.Visible = $false; $app.DisplayAlerts = $false
    try { $book = $app.Workbooks.Open($source, 0, $true); $app.PrintCommunication = $false
      foreach ($sheet in $book.Worksheets) { $sheet.PageSetup.Zoom = $false; $sheet.PageSetup.FitToPagesWide = 1; $sheet.PageSetup.FitToPagesTall = $false }
      $app.PrintCommunication = $true; $book.ExportAsFixedFormat(0, $output); $book.Close($false) } finally { if ($app.Workbooks.Count -eq 0) { $app.Quit() } } }
  'powerpoint' { $app = New-Object -ComObject PowerPoint.Application
    try { $deck = $app.Presentations.Open($source, -1, 0, 0); $deck.SaveAs($output, 32); $deck.Close() } finally { if ($app.Presentations.Count -eq 0) { $app.Quit() } } }
}`;
	const file = join(work, "render.ps1");
	writeFileSync(file, script);
	return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
		"Showing Office files as pages needs Microsoft Office on this computer.");
}

/** Keeps the most recently used renders. */
function prune(cache: string): void {
	const files = readdirSync(cache).filter(name => name.endsWith(".pdf")).map(name => ({ path: join(cache, name), used: statSync(join(cache, name)).mtimeMs }));
	for (const old of files.sort((a, b) => b.used - a.used).slice(KEEP)) rmSync(old.path, { force: true });
}
