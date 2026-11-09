import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export { OFFICE_PAGES } from "../shared/files.ts";

/** Microsoft Office is given longer: a slow file is common, and a stopped conversion's Office application is stopped too (releaseOffice). */
const KEEP = 200, TIMEOUT = process.platform === "win32" ? 150_000 : 50_000;
/**
 * Conversions run one at a time: several at once each started Word, Excel or PowerPoint, and Office never quit an
 * application another conversion was still using. A version already on its way is shared. Desk and the conversations'
 * read tools (pi-show) take turns across processes through a lock folder in the cache.
 */
let queue: Promise<unknown> = Promise.resolve();
const converting = new Map<string, Promise<string>>();

/**
 * The file's pages as a PDF, made by the Office suite on this computer: Microsoft Office on Windows, LibreOffice
 * elsewhere. Kept by file version under the agent directory, so a file is converted once while it is unchanged.
 * Spreadsheets are fitted one page wide, so a sheet reads as one sheet rather than as printed strips.
 */
export function officePdf(path: string, version: string): Promise<string> {
	const cache = join(getAgentDir(), "cache", "office-pages"), pdf = join(cache, version + ".pdf");
	if (existsSync(pdf)) { const now = new Date(); utimesSync(pdf, now, now); return Promise.resolve(pdf); }
	let pending = converting.get(version);
	if (!pending) {
		pending = queue.then(() => convert(path, cache, pdf)).finally(() => converting.delete(version));
		converting.set(version, pending); queue = pending.catch(() => {});
	}
	return pending;
}

/** Waits for this computer's other conversions to finish, then holds the turn while `work` runs. */
async function turn<T>(cache: string, work: () => Promise<T>): Promise<T> {
	const lock = join(cache, "converting.lock");
	for (;;) {
		try { mkdirSync(lock); break; } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// A lock older than any conversion may take was left by a process that stopped during one.
			try { if (Date.now() - statSync(lock).mtimeMs > TIMEOUT + 30_000) rmSync(lock, { recursive: true, force: true }); } catch { /* released meanwhile */ }
			await new Promise(resolve => setTimeout(resolve, 500));
		}
	}
	try { return await work(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

async function convert(path: string, cache: string, pdf: string): Promise<string> {
	if (existsSync(pdf)) return pdf;
	mkdirSync(cache, { recursive: true });
	return turn(cache, () => existsSync(pdf) ? Promise.resolve(pdf) : render(path, cache, pdf));
}

async function render(path: string, cache: string, pdf: string): Promise<string> {
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

/** The Office suite did not finish in time; what it started may still be running. */
class OfficeTimeout extends Error {}

function run(command: string, args: string[], missing: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
		let errors = "";
		const timer = setTimeout(() => { child.kill(); reject(new OfficeTimeout("The Office suite took too long to render this file.")); }, TIMEOUT);
		child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
		child.on("error", error => { clearTimeout(timer); reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(missing) : error); });
		child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("The Office suite could not render this file: " + (errors.trim() || "exit " + code))); });
	});
}

const OFFICE = {
	word: { progId: "Word.Application", process: "WINWORD", files: "Documents" },
	excel: { progId: "Excel.Application", process: "EXCEL", files: "Workbooks" },
	powerpoint: { progId: "PowerPoint.Application", process: "POWERPNT", files: "Presentations" },
} as const;
/** Given to every file opened, so a protected one fails at once instead of waiting on a password prompt nobody sees. */
const NO_PASSWORD = "desk-no-password";

/**
 * Word, Excel or PowerPoint through their automation interface, opening a copy read-only, without a window, with its
 * macros disabled and nothing to answer. The file opened is always closed again. Word and Excel start an instance of
 * their own; PowerPoint runs one, which may be Jordan's with his decks open. An application quits only when it holds
 * nothing, and Desk stops one only if this conversion started it (releaseOffice).
 */
async function windowsPdf(source: string, output: string, work: string): Promise<void> {
	const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
	const kind = /\.(xlsx|xlsm|xls|ods)$/i.test(source) ? "excel" : /\.(pptx|pptm|ppt|odp)$/i.test(source) ? "powerpoint" : "word";
	const office = OFFICE[kind], owner = join(work, "office.json"), missing = "[Type]::Missing", password = quote(NO_PASSWORD);
	const open = {
		word: `$app.Visible = $false; $app.DisplayAlerts = 0
    $file = $app.Documents.Open($source, $false, $true, $false, ${password}, ${password}, $false, ${password}, ${password}, 0, ${missing}, ${missing}, $false, ${missing}, $true)
    $file.ExportAsFixedFormat($output, 17)`,
		excel: `$app.Visible = $false; $app.DisplayAlerts = $false; $app.AskToUpdateLinks = $false; $app.EnableEvents = $false
    $file = $app.Workbooks.Open($source, 0, $true, ${missing}, ${password}, ${password}, $true, ${missing}, ${missing}, $false, $false, ${missing}, $false)
    $app.PrintCommunication = $false
    foreach ($sheet in $file.Worksheets) { $sheet.PageSetup.Zoom = $false; $sheet.PageSetup.FitToPagesWide = 1; $sheet.PageSetup.FitToPagesTall = $false }
    $app.PrintCommunication = $true; $file.ExportAsFixedFormat(0, $output)`,
		powerpoint: `$file = $app.Presentations.Open($source, -1, 0, 0); $file.SaveAs($output, 32)`,
	}[kind];
	const script = `$ErrorActionPreference = 'Stop'
$source = ${quote(source)}; $output = ${quote(output)}; $owner = ${quote(owner)}
$before = @(Get-Process -Name '${office.process}' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$app = New-Object -ComObject '${office.progId}'
# The instance this started, if it started one, recorded before anything that can block, so Desk can stop that one alone.
$mine = @(Get-Process -Name '${office.process}' -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
$record = $null; $file = $null; $security = $null
try {
  if ($mine.Count -eq 1) { $record = @{ pid = $mine[0].Id; start = [string]$mine[0].StartTime.ToFileTimeUtc(); name = '${office.process}'; quit = $false }
    $record | ConvertTo-Json -Compress | Set-Content -LiteralPath $owner -Encoding ASCII }
  $security = $app.AutomationSecurity; $app.AutomationSecurity = 3
  ${open}
} finally {
  if ($file) { try { ${kind === "powerpoint" ? "$file.Close()" : "$file.Close($false)"} } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($file) }
  $open = 1; try { $open = $app.${office.files}.Count } catch {}
  if ($open -eq 0) {
    try { ${kind === "word" ? "$app.Quit(0)" : "$app.Quit()"}; if ($record) { $record.quit = $true; $record | ConvertTo-Json -Compress | Set-Content -LiteralPath $owner -Encoding ASCII } } catch {}
  } elseif ($null -ne $security) { try { $app.AutomationSecurity = $security } catch {} }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}`;
	const file = join(work, "render.ps1");
	writeFileSync(file, script);
	let stuck = false;
	try {
		await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
			"Showing Office files as pages needs Microsoft Office on this computer.");
	} catch (error) { stuck = error instanceof OfficeTimeout; throw error; }
	finally {
		// A stuck application holds the copy, so it is stopped before the copy is deleted; one that quit is checked later.
		const release = releaseOffice(owner, stuck);
		if (stuck) await release;
	}
}

/**
 * Stops the Office application a conversion started when it should no longer run: the conversion was stopped while
 * Office was blocked, often on a dialog nobody can see, or Office was asked to quit, holding no files, and is still
 * there 10 seconds later. Only that process is stopped, and only while its name and start time are the ones the
 * conversion recorded; Office applications started by anything else are never touched.
 */
function releaseOffice(file: string, stuck: boolean): Promise<void> {
	let owner: { pid?: unknown; start?: unknown; name?: unknown; quit?: unknown };
	try { owner = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return Promise.resolve(); }
	if (!stuck && owner.quit !== true || !Number.isSafeInteger(owner.pid) || typeof owner.start !== "string" || !/^\d{1,20}$/.test(owner.start)
		|| !Object.values(OFFICE).some(office => office.process === owner.name)) return Promise.resolve();
	const script = `$p = Get-Process -Id ${owner.pid} -ErrorAction SilentlyContinue
if ($p -and $p.ProcessName -eq '${owner.name}' -and [string]$p.StartTime.ToFileTimeUtc() -eq '${owner.start}') {
  if (-not $p.WaitForExit(${stuck ? 0 : 10_000})) { Stop-Process -Id ${owner.pid} -Force; [void]$p.WaitForExit(10000) } }`;
	return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], "PowerShell is missing.").catch(() => {});
}

/** Keeps the most recently used renders. */
function prune(cache: string): void {
	const files = readdirSync(cache).filter(name => name.endsWith(".pdf")).map(name => ({ path: join(cache, name), used: statSync(join(cache, name)).mtimeMs }));
	for (const old of files.sort((a, b) => b.used - a.used).slice(KEEP)) rmSync(old.path, { force: true });
}
