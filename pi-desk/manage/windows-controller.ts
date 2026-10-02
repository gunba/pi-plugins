import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { windowsQuote } from "../src/host/login-manager.ts";

const powershell = () => win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const literal = (value: string) => {
	if (/[\0-\x1f]/.test(value)) throw new Error("Controller paths cannot contain control characters.");
	return `'${value.replaceAll("'", "''")}'`;
};
export const controllerAck = (home: string, id: string): string => {
	if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid controller launch.");
	return join(home, "controllers", `${id}.json`);
};
interface ControllerTask { home: string; cwd: string; node: string; entry: string; args: string[]; launch: string }
/** The scheduler owns the controller, outside the host's process tree/job. */
export function controllerTaskScript(c: ControllerTask): string {
	controllerAck(c.home, c.launch);
	const name = `pi-desk-controller-${c.launch}`, owner = `Pi Desk controller ${c.home} ${c.launch}`;
	const output = join(c.home, "controllers", `${c.launch}.stdout`), error = join(c.home, "controllers", `${c.launch}.stderr`);
	const run = `$ErrorActionPreference = 'Stop'
$code = 1
try {
 $process = Start-Process -FilePath ${literal(c.node)} -ArgumentList ${literal([c.entry, ...c.args, "--launch", c.launch].map(windowsQuote).join(" "))} -WorkingDirectory ${literal(c.cwd)} -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput ${literal(output)} -RedirectStandardError ${literal(error)}
 $code = $process.ExitCode
} catch { [IO.File]::AppendAllText(${literal(join(c.home, "operation.log"))}, [string]$_ + [Environment]::NewLine) }
finally {
 foreach ($file in @(${literal(output)}, ${literal(error)})) {
  if (Test-Path -LiteralPath $file) {
   try { [IO.File]::AppendAllText(${literal(join(c.home, "operation.log"))}, [IO.File]::ReadAllText($file)); Remove-Item -LiteralPath $file -Force } catch {}
  }
 }
 [IO.File]::AppendAllText(${literal(join(c.home, "operation.log"))}, [DateTime]::UtcNow.ToString('o') + ' Controller ${c.launch} exited ' + $code + [Environment]::NewLine)
 $task = Get-ScheduledTask -TaskName ${literal(name)} -TaskPath '\\' -ErrorAction SilentlyContinue
 if ($task -and $task.Description -eq ${literal(owner)}) { Unregister-ScheduledTask -TaskName ${literal(name)} -TaskPath '\\' -Confirm:$false }
}
exit $code`;
	const arguments_ = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(run, "utf16le").toString("base64")];
	return `$ErrorActionPreference = 'Stop'
$name = ${literal(name)}
if (Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue) { throw 'This controller task already exists.' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$action = New-ScheduledTaskAction -Execute ${literal(powershell())} -Argument ${literal(arguments_.map(windowsQuote).join(" "))} -WorkingDirectory ${literal(c.cwd)}
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -DisallowHardTerminate -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $action -Principal $principal -Settings $settings -Description ${literal(owner)} | Out-Null
try { Start-ScheduledTask -TaskName $name -TaskPath '\\' }
catch { Unregister-ScheduledTask -TaskName $name -TaskPath '\\' -Confirm:$false; throw }
`;
}
export async function launchWindowsController(c: Omit<ControllerTask, "launch">): Promise<void> {
	const launch = randomUUID(), ack = controllerAck(c.home, launch);
	mkdirSync(join(c.home, "controllers"), { recursive: true, mode: 0o700 });
	const script = controllerTaskScript({ ...c, launch });
	try {
		await promisify(execFile)(powershell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
			{ windowsHide: true, timeout: 55_000, maxBuffer: 128 * 1024 });
	} catch { throw new Error("Independent controller startup is unconfirmed. Check Desk status and Task Scheduler permissions before retrying."); }
	const until = Date.now() + 20_000;
	while (Date.now() < until) {
		if (existsSync(ack)) {
			let result: { type?: string; error?: string };
			try { result = JSON.parse(readFileSync(ack, "utf8")); } catch { await delay(100); continue; }
			unlinkSync(ack);
			if (result.type === "accepted") return;
			throw new Error(result.error ?? "Desk controller rejected the operation. Check operation.log.");
		}
		await delay(100);
	}
	throw new Error("Controller startup is unconfirmed. Check Desk status before retrying; do not launch another update.");
}
