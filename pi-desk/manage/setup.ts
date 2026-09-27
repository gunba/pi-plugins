import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeInstallation } from "./installation.ts";

/** Native dialogs keep the same setup flow in the terminal and Desk. */
export async function chooseStartup(ctx: ExtensionContext): Promise<Pick<RuntimeInstallation, "cwd" | "port" | "sessionDir" | "proxy"> | undefined> {
	const value: Pick<RuntimeInstallation, "cwd" | "port" | "sessionDir" | "proxy"> = { cwd: ctx.cwd, port: 8910 };
	for (;;) {
		const choice = await ctx.ui.select(`Host defaults\nProject: ${value.cwd}\nPort: ${value.port}\nSessions: ${value.sessionDir ?? "Pi default"}\nProxy: ${value.proxy ? "custom" : "environment"}`,
			["Continue", "Project directory", "Port", "Session directory", "Proxy"]);
		if (!choice) return;
		if (choice === "Continue") return value;
		const text = await ctx.ui.input(choice === "Session directory" ? "Session directory (empty uses Pi settings)"
			: choice === "Proxy" ? "Proxy URL (empty uses environment)" : choice,
		choice === "Port" ? String(value.port) : choice === "Project directory" ? value.cwd : undefined);
		if (text === undefined) continue;
		try {
			if (choice === "Project directory") {
				const cwd = realpathSync(resolve(text.trim() || value.cwd));
				if (!statSync(cwd).isDirectory()) throw new Error("Choose an existing project directory.");
				value.cwd = cwd;
			}
			else if (choice === "Port") {
				const port = text.trim() || String(value.port);
				if (!/^\d+$/.test(port) || Number(port) > 65535) throw new Error("Choose a port from 0 to 65535. Zero selects a free port.");
				value.port = Number(port);
			} else if (choice === "Session directory") value.sessionDir = text.trim() ? resolve(text.trim()) : undefined;
			else if (choice === "Proxy") value.proxy = text.trim() || undefined;
		} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
	}
}
