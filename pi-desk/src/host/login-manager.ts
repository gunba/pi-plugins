import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { promisify } from "node:util";
import { SessionLease, SessionOwnedError } from "../../../pi-session-ownership/lease.ts";
import { atomicJson } from "../../manage/store.ts";
import { loginFile, marker, type LoginConfig } from "./login-config.ts";

const execute = promisify(execFile);
export interface LoginStatus { configured: boolean; name?: string; platform?: string; enabled?: boolean; state?: string; result?: number; environment?: string[]; error?: string }
function safe(value: string): string {
	if (/[\0-\x1f]/.test(value)) throw new Error("Login-start paths cannot contain control characters.");
	return value;
}
export const unitQuote = (value: string): string => `"${safe(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;
export const windowsQuote = (value: string): string => `"${safe(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
const ps = (value: string): string => `'${safe(value).replaceAll("'", "''")}'`;
const system32 = (...parts: string[]): string => win32.join(process.env.SystemRoot || "C:\\Windows", "System32", ...parts);
const powershellPath = (): string => system32("WindowsPowerShell", "v1.0", "powershell.exe");
/**
 * The program and argument string of the Windows login-start task: the wrapper (login-run) under a console that has
 * no window. A task's console is otherwise a window the user can close, which ends the wrapper and the host with it;
 * PowerShell's -WindowStyle Hidden does not hide it where Windows Terminal is the default terminal (Windows 11 22H2
 * and later). conhost exits with 0 whatever the wrapper returned, so a failed start is read from login-error.txt,
 * not from the task's result. Needs Windows 10 1809 or later, where conhost has --headless.
 */
export function taskAction(c: LoginConfig): { execute: string; arguments: string } {
	return { execute: system32("conhost.exe"), arguments: ["--headless", "--", ...[c.node, c.entry, "login-run", "--data-dir", c.directory].map(windowsQuote)].join(" ") };
}
export function unitText(c: LoginConfig): string {
	const command = [c.node, c.entry].map(unitQuote).join(" ");
	return `# ${marker(c)}
[Unit]
Description=Pi Desk
StartLimitIntervalSec=300
StartLimitBurst=5
[Service]
Type=exec
ExecStart=${command} login-run --data-dir ${unitQuote(c.directory)}
ExecStop=${command} stop --host-only --data-dir ${unitQuote(c.directory)}
KillMode=process
SendSIGKILL=no
TimeoutStopSec=45
# A runaway command hits this limit and is killed alone (commands raise their OOM score) instead of the desktop.
MemoryMax=75%
MemorySwapMax=4G
OOMPolicy=continue
# After any crash or kill, including systemd-oomd's, which on-failure does not restart; not after a clean exit.
Restart=always
RestartPreventExitStatus=0
RestartSec=10
[Install]
WantedBy=default.target
`;
}
async function systemctl(...args: string[]): Promise<string> {
	return (await execute("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 55_000, maxBuffer: 128 * 1024 })).stdout.trim();
}
export function taskScript(c: LoginConfig, operation: "install" | "refresh" | "status" | "start" | "disable" | "remove"): string {
	const action = (): string => { const { execute, arguments: line } = taskAction(c); return `New-ScheduledTaskAction -Execute ${ps(execute)} -Argument ${ps(line)}`; };
	const setup = `$ErrorActionPreference = 'Stop'
$name = ${ps(c.name)}
$owner = ${ps(marker(c))}
$task = Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue
if ($task -and $task.Description -ne $owner) { throw 'This task is not owned by this Pi Desk installation.' }
`;
	switch (operation) {
		case "install": return `${setup}
if ($task) { throw 'The login-start task already exists.' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$action = ${action()}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -DisallowHardTerminate -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $owner | Out-Null
`;
		// Replaces the action alone; a running instance keeps the action it started with.
		case "refresh": return `${setup}
if (-not $task) { 'missing'; exit }
Set-ScheduledTask -TaskName $name -TaskPath '\\' -Action (${action()}) | Out-Null
'updated'
`;
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
/**
 * Brings this installation's unit or task up to date when an earlier release wrote it differently. systemd applies a
 * rewritten unit on reload. A Windows task gets its action replaced once, which login.json then records; the wrapper
 * already running keeps its window until the task next starts.
 */
export async function refreshManager(c: LoginConfig): Promise<void> {
	if (c.platform === "win32") {
		if (c.console === "headless") return;
		let edit: SessionLease;
		// Another command is installing, migrating or removing login-start; the next host start tries again.
		try { edit = new SessionLease(join(c.directory, "login-edit")); } catch (error) { if (error instanceof SessionOwnedError) return; throw error; }
		try { if (await powershell(c, "refresh") === "updated") atomicJson(loginFile(c.directory), { ...c, console: "headless" }); }
		finally { edit.close(); }
		return;
	}
	if (!ownUnit(c)) return;
	const text = unitText(c);
	if (readFileSync(c.unit!, "utf8") === text) return;
	writeFileSync(c.unit!, text, { mode: 0o600 });
	await systemctl("daemon-reload");
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
