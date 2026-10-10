import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const system32 = () => win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32");

/**
 * taskkill /T kills the tree it sees at that instant. A shell killed while it is creating a child (Git Bash's
 * launcher -> bash -> command) leaves that child running, parented to a process that no longer exists.
 * Starting from every process taskkill reported, kill children created since the command started until two
 * passes find none. The creation-time bound keeps reused process IDs out.
 */
const ORPHAN_SWEEP = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$tree = @{}; foreach ($id in $env:PI_SWEEP_TREE.Split(',')) { $tree[[int]$id] = $true }
$since = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$env:PI_SWEEP_SINCE).UtcDateTime.AddSeconds(-1)
$deadline = (Get-Date).AddMilliseconds(1500); $quiet = 0
while ((Get-Date) -lt $deadline -and $quiet -lt 2) {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)
  $found = @()
  do {
    $added = $false
    foreach ($p in $all) {
      $id = [int]$p.ProcessId
      if (-not $tree.ContainsKey($id) -and $tree.ContainsKey([int]$p.ParentProcessId) -and $p.CreationDate -and $p.CreationDate.ToUniversalTime() -ge $since) {
        $tree[$id] = $true; $found += $id; $added = $true
      }
    }
  } while ($added)
  if ($found.Count) { $quiet = 0; foreach ($id in $found) { Stop-Process -Id $id -Force } } else { $quiet++; Start-Sleep -Milliseconds 100 }
}`;

/** Same process-tree mechanism as Pi's native shell tool, plus a sweep for children created during it. */
export async function terminateWindowsProcessTree(pid: number, since?: number): Promise<void> {
	let failure: unknown, output = "";
	try {
		const result = await run(win32.join(system32(), "taskkill.exe"), ["/F", "/T", "/PID", String(pid)], { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
		output = result.stdout + result.stderr;
	} catch (error) {
		failure = error;
		output = `${(error as { stdout?: unknown }).stdout ?? ""}${(error as { stderr?: unknown }).stderr ?? ""}`;
	}
	if (since !== undefined) {
		// taskkill names each process and its parent ("PID 1234 (child process of PID 1000)", localised).
		const tree = new Set([pid, ...(output.match(/\d+/g) ?? []).map(Number).filter(id => id > 0 && id <= 0xffffffff)]);
		// Best effort: taskkill's result decides success; a blocked PowerShell must not turn it into a failure.
		await run(win32.join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", ORPHAN_SWEEP], {
			windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024,
			env: { ...process.env, PI_SWEEP_TREE: [...tree].join(","), PI_SWEEP_SINCE: String(Math.floor(since)) },
		}).catch(() => {});
	}
	if (failure) throw failure;
}
