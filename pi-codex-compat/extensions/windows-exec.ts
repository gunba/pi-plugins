import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const system32 = () => win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const taskkill = (pid: number) => run(win32.join(system32(), "taskkill.exe"), ["/F", "/T", "/PID", String(pid)],
	{ windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });

/**
 * taskkill /T only kills the tree it sees at that instant. A process a shell is still creating (for
 * example Git Bash's launcher -> bash -> command) appears afterwards with an already-dead parent.
 * Snapshot the tree before killing, then keep killing new children of anything in it until two
 * passes find none. Only processes created since the command started are touched, so reused IDs
 * of unrelated processes are not.
 */
const TREE_KILL = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$root = [int]$env:PI_KILL_ROOT
$since = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$env:PI_KILL_SINCE).UtcDateTime
$tree = @{ $root = $true }; $first = $true; $quiet = 0
$deadline = (Get-Date).AddMilliseconds(3000)
while ((Get-Date) -lt $deadline -and $quiet -lt 2) {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)
  $found = @()
  if ($first) {
    $first = $false
    $self = $all | Where-Object { [int]$_.ProcessId -eq $root } | Select-Object -First 1
    if ($self -and [Math]::Abs(($self.CreationDate.ToUniversalTime() - $since).TotalSeconds) -lt 30) { $found += $root }
  }
  do {
    $added = $false
    foreach ($p in $all) {
      $id = [int]$p.ProcessId
      if (-not $tree.ContainsKey($id) -and $tree.ContainsKey([int]$p.ParentProcessId) -and $p.CreationDate -and $p.CreationDate.ToUniversalTime() -ge $since.AddSeconds(-1)) {
        $tree[$id] = $true; $found += $id; $added = $true
      }
    }
  } while ($added)
  if ($found.Count) { $quiet = 0; foreach ($id in $found) { Stop-Process -Id $id -Force } } else { $quiet++; Start-Sleep -Milliseconds 100 }
}
'done'`;

/** Kill a command's whole process tree, including children created while it is being killed. */
export async function terminateWindowsProcessTree(pid: number, since?: number): Promise<void> {
	if (since !== undefined) {
		try {
			const { stdout } = await run(win32.join(system32(), "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", TREE_KILL], {
				windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
				env: { ...process.env, PI_KILL_ROOT: String(pid), PI_KILL_SINCE: String(Math.floor(since)) },
			});
			if (stdout.trim().endsWith("done")) return;
		} catch { /* PowerShell blocked or unavailable: fall back to taskkill. */ }
	}
	await taskkill(pid);
}
