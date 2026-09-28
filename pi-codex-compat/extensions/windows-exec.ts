import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Same process-tree mechanism as Pi's native shell tool, with observed failures. */
export async function terminateWindowsProcessTree(pid: number): Promise<void> {
	await run(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), [
		"/F", "/T", "/PID", String(pid),
	], {
		windowsHide: true,
		timeout: 10_000,
		maxBuffer: 64 * 1024,
	});
}
