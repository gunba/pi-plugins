import { spawn } from "node:child_process";
import { dirname, extname, win32 } from "node:path";
import { pathToFileURL } from "node:url";

export type DesktopFileAction = "open" | "reveal";
const executable = /^(?:\.exe|\.com|\.bat|\.cmd|\.msi|\.msp|\.scr|\.cpl|\.lnk|\.url|\.desktop|\.app|\.ps1|\.psm1|\.vbs|\.vbe|\.wsf|\.wsh|\.hta|\.reg|\.jar|\.sh|\.bash|\.zsh)$/i;
export function desktopFileCommand(path: string, action: DesktopFileAction, platform = process.platform, systemRoot = process.env.SystemRoot ?? "C:\\Windows") {
	if (action === "open" && (executable.test(extname(path)) || platform === "win32" && /\.(?:js|jse|py|pyw|rb|pl)$/i.test(path)))
		throw new Error("Desk does not launch executable files. Show the containing folder or use Preview instead.");
	if (platform === "win32") return action === "reveal"
		? { command: win32.join(systemRoot, "explorer.exe"), args: ["/select,", path] }
		: { command: win32.join(systemRoot, "System32", "rundll32.exe"), args: ["url.dll,FileProtocolHandler", pathToFileURL(path, { windows: true }).href] };
	if (platform !== "linux") throw new Error("Native file opening is available on Windows and Linux.");
	return { command: "xdg-open", args: [action === "reveal" ? dirname(path) : path] };
}
export async function openDesktopFile(path: string, action: DesktopFileAction): Promise<void> {
	const { command, args } = desktopFileCommand(path, action);
	const child = spawn(command, args, { detached: true, windowsHide: true, stdio: "ignore" });
	await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
	child.unref();
}
