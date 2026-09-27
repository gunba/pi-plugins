import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, win32 } from "node:path";
import { promisify } from "node:util";
import { marker, type LoginConfig } from "./login-config.ts";

const execute = promisify(execFile);
export interface LoginStatus { configured: boolean; name?: string; platform?: string; enabled?: boolean; state?: string; result?: number; environment?: string[]; error?: string }
function safe(value: string): string {
	if (/[\0-\x1f]/.test(value)) throw new Error("Login-start paths cannot contain control characters.");
	return value;
}
export const unitQuote = (value: string): string => `"${safe(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;
export const windowsQuote = (value: string): string => `"${safe(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
const ps = (value: string): string => `'${safe(value).replaceAll("'", "''")}'`;
const powershellPath = (): string => win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
export function unitText(c: LoginConfig): string {
	const command = [c.node, c.entry].map(unitQuote).join(" ");
	return `# ${marker(c)}
[Unit]
Description=Pi Desk
[Service]
Type=exec
ExecStart=${command} login-run --data-dir ${unitQuote(c.directory)}
ExecStop=${command} stop --host-only --data-dir ${unitQuote(c.directory)}
KillMode=process
SendSIGKILL=no
TimeoutStopSec=45
Restart=no
[Install]
WantedBy=default.target
`;
}
async function systemctl(...args: string[]): Promise<string> {
	return (await execute("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 55_000, maxBuffer: 128 * 1024 })).stdout.trim();
}
export function taskScript(c: LoginConfig, operation: "install" | "status" | "start" | "disable" | "remove"): string {
	const setup = `$ErrorActionPreference = 'Stop'
$name = ${ps(c.name)}
$owner = ${ps(marker(c))}
$task = Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue
if ($task -and $task.Description -ne $owner) { throw 'This task is not owned by this Pi Desk installation.' }
`;
	switch (operation) {
		case "install": {
			const run = `$ErrorActionPreference = 'Stop'\n& ${[c.node, c.entry, "login-run", "--data-dir", c.directory].map(ps).join(" ")}\nexit $LASTEXITCODE`;
			const arguments_ = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(run, "utf16le").toString("base64")];
			return `${setup}
if ($task) { throw 'The login-start task already exists.' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$action = New-ScheduledTaskAction -Execute ${ps(powershellPath())} -Argument ${ps(arguments_.map(windowsQuote).join(" "))}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -DisallowHardTerminate -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $owner | Out-Null
`;
		}
		case "status": return `${setup}
if (-not $task) { @{ enabled = $false; state = 'missing' } | ConvertTo-Json -Compress; exit }
$info = Get-ScheduledTaskInfo -TaskName $name -TaskPath '\\'
@{ enabled = $task.Settings.Enabled; state = $task.State.ToString(); result = $info.LastTaskResult } | ConvertTo-Json -Compress
`;
		case "start": return `${setup}
if (-not $task -or $task.State -eq 'Disabled') { throw 'Login-start is missing or disabled. Reinstall it before starting.' }
Start-ScheduledTask -TaskName $name -TaskPath '\\'
`;
		case "disable": return `${setup}
if ($task) { Disable-ScheduledTask -TaskName $name -TaskPath '\\' | Out-Null }
`;
		case "remove": return `${setup}
if ($task -and $task.State -eq 'Running') { throw 'The login-start process has not exited. Wait for it before removing the task.' }
if ($task) { Unregister-ScheduledTask -TaskName $name -TaskPath '\\' -Confirm:$false }
`;
	}
}
async function powershell(c: LoginConfig, operation: Parameters<typeof taskScript>[1]): Promise<string> {
	return (await execute(powershellPath(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(taskScript(c, operation), "utf16le").toString("base64")],
		{ encoding: "utf8", windowsHide: true, timeout: 55_000, maxBuffer: 128 * 1024 })).stdout.trim();
}
function ownUnit(c: LoginConfig): boolean {
	if (!existsSync(c.unit!)) return false;
	if (!readFileSync(c.unit!, "utf8").startsWith(`# ${marker(c)}\n`)) throw new Error("This service file is not owned by this Pi Desk installation.");
	return true;
}
export async function managerStatus(c: LoginConfig): Promise<LoginStatus> {
	try {
		if (c.platform !== process.platform) throw new Error("Login-start belongs to a different operating system; do not copy login.json between computers.");
		if (c.platform === "win32") return { configured: true, name: c.name, platform: c.platform, ...JSON.parse(await powershell(c, "status")) };
		if (!ownUnit(c)) return { configured: true, name: c.name, platform: c.platform, enabled: false, state: "missing" };
		const fields = Object.fromEntries((await systemctl("show", `${c.name}.service`, "-p", "ActiveState,UnitFileState,LoadState")).split("\n").map(v => v.split("=")));
		return { configured: true, name: c.name, platform: c.platform, enabled: fields.UnitFileState === "enabled", state: fields.LoadState === "loaded" ? fields.ActiveState : fields.LoadState };
	} catch (error) { return { configured: true, name: c.name, platform: c.platform, error: managerError(error) }; }
}
function managerError(error: unknown): string {
	// execFile errors include command lines; never include captured private startup settings.
	const e = error as { stderr?: string; message?: string };
	return (e.stderr || e.message || String(error)).slice(0, 1600);
}
export async function installManager(c: LoginConfig): Promise<void> {
	if (c.platform === "win32") { await powershell(c, "install"); return; }
	await systemctl("show-environment");
	mkdirSync(dirname(c.unit!), { recursive: true, mode: 0o700 });
	writeFileSync(c.unit!, unitText(c), { flag: "wx", mode: 0o600 });
	await systemctl("daemon-reload");
	await systemctl("enable", `${c.name}.service`);
}
export async function startManager(c: LoginConfig): Promise<void> {
	const status = await managerStatus(c);
	if (status.error || !status.enabled) throw new Error(status.error ?? "Login-start is missing or disabled. Remove/reinstall it before starting.");
	if (c.platform === "win32") await powershell(c, "start");
	else await systemctl("start", `${c.name}.service`);
}
export async function disableManager(c: LoginConfig): Promise<void> {
	if (c.platform === "win32") await powershell(c, "disable");
	else if (ownUnit(c)) await systemctl("disable", `${c.name}.service`);
}
export async function stopManager(c: LoginConfig): Promise<void> {
	if (c.platform === "linux" && ownUnit(c)) await systemctl("stop", `${c.name}.service`);
}
export async function removeManager(c: LoginConfig): Promise<void> {
	if (c.platform === "win32") { await powershell(c, "remove"); return; }
	if (ownUnit(c)) {
		await systemctl("stop", `${c.name}.service`);
		await systemctl("disable", `${c.name}.service`);
		unlinkSync(c.unit!);
		await systemctl("daemon-reload");
	}
}
