import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { isManagedChild } from "../../pi-work-coordination/index.ts";
import { readInstallation, installationFile } from "../manage/installation.ts";
import { deskStatus, extensionLocation, launchOperation, operationStatus, runLauncher, runOperation, statusText, type DeskOperation } from "../manage/operations.ts";
import { openBrowser } from "../src/host/lifecycle.ts";
import { readLoginConfig } from "../src/host/login-config.ts";
import { chooseStartup } from "../manage/setup.ts";

const commands = ["status", "setup", "open", "stage", "update", "restart", "rollback", "stop", "signin", "login"] as const;
export default function desk(pi: ExtensionAPI) {
	const agentDir = getAgentDir(), location = extensionLocation(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), agentDir);
	let context: ExtensionContext | undefined, automatic = false, shutdown = false;
	const initial = new AbortController();
	const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
		if (!shutdown && context?.hasUI) context.ui.notify(message, level);
	};
	const directory = () => existsSync(installationFile(location.home)) ? readInstallation(location.home).directory : join(agentDir, "desk");
	const status = () => deskStatus(location.home, directory());
	const options = (ctx: ExtensionContext, action: DeskOperation) => ({
		...location, action, agentDir, cwd: ctx.cwd, directory: directory(), signal: initial.signal,
		progress: (value: { message: string }) => {
			if (!shutdown) ctx.ui.setStatus("desk", value.message);
		},
	});
	pi.registerCommand("desk", {
		description: "Manage the Desk host, prepared updates and login-start",
		getArgumentCompletions: prefix => commands.filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (process.env.PI_SUBAGENT_TASK_PATH || isManagedChild(pi)) throw new Error("Desk management belongs to the parent session.");
			if (!ctx.hasUI) throw new Error("Use /desk in interactive Pi or Desk, or use the managed launcher from a shell.");
			context = ctx;
			let [command, ...parameters] = args.trim().split(/\s+/);
			if (!command) {
				const state = await status();
				command = await ctx.ui.select(statusText(state), state.state?.active
					? ["open", "status", "stage", "update", "restart", "rollback", "stop", "signin", "login"]
					: ["setup", "status"]) ?? "";
			}
			if (!command) return;
			if (!commands.includes(command as typeof commands[number])) throw new Error("Use /desk to choose an operation.");
			if (!["signin", "login"].includes(command) && parameters.length) throw new Error("This Desk command takes no arguments.");
			try {
				if (command === "status") { notify(statusText(await status())); return; }
				if (command === "setup") {
					if ((await status()).state?.active) { notify("Desk is already configured. Use /desk to manage it."); return; }
					if (!await ctx.ui.confirm("Set up Desk?", "Prepare an isolated runtime and retain the account and native sessions. Saved login-start options are kept. An existing host must be stopped first.")) return;
					let data = directory();
					if (!existsSync(join(data, "account.json")) && !existsSync(join(data, "login.json"))) {
						const chosen = await ctx.ui.input("Desk data directory (Enter keeps the default)", data);
						if (chosen === undefined) return;
						data = chosen.trim() ? resolve(chosen.trim()) : data;
					}
					const needsDefaults = !readLoginConfig(data) && !existsSync(installationFile(location.home));
					const startup = needsDefaults ? await chooseStartup(ctx) : undefined;
					if (needsDefaults && !startup) return;
					await runOperation({ ...options(ctx, "setup"), directory: data, startup }); notify("Desk is ready. Use /desk open, or /desk signin for a new workspace."); return;
				}
				if (!(await status()).state?.active) throw new Error("Run /desk setup first.");
				if (command === "open") {
					const url = await runLauncher(location.home, ["open", "--print"]);
					if (ctx.mode === "tui") await openBrowser(url); else notify(`Workspace: ${url}`);
					return;
				}
				if (command === "signin") {
					const workspace = parameters[0] ?? await ctx.ui.input("Workspace address", "https://desk.example.com");
					if (!workspace) return;
					if (parameters.length > 1) throw new Error("Use /desk signin with one workspace address.");
					const url = new URL(workspace);
					if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Enter the HTTPS workspace address.");
					notify("Microsoft sign-in opens on this computer.");
					await runLauncher(location.home, ["signin", "--workspace", url.origin]);
					notify("This computer is signed in."); return;
				}
				if (command === "login") {
					const choice = parameters[0] ?? await ctx.ui.select("Login-start", ["status", "install", "remove"]);
					if (!choice) return;
					if (parameters.length > 1 || !["status", "install", "remove"].includes(choice)) throw new Error("Use /desk login status, install or remove.");
					if (choice !== "status" && !await ctx.ui.confirm("Change login-start?", choice === "install"
						? "Restart this host and enable it at user login. Open sessions and background work will be interrupted; resume explicitly afterward."
						: "Restart without login-start. Open sessions and background work will be interrupted; native history is retained.")) return;
					if (choice === "status") notify(await runLauncher(location.home, ["login", "status"]));
					else { await launchOperation(location.home, choice === "install" ? "login-install" : "login-remove"); notify("Login-start change accepted. Use /desk status after reconnecting."); }
					return;
				}
				if (["restart", "rollback", "stop"].includes(command)) {
					const current = await status();
					if (!await ctx.ui.confirm(command === "stop" ? "Stop Desk?" : command === "rollback" ? "Use the previous runtime?" : "Restart Desk?",
						`${current.host.host?.sessions.active ?? 0} running Pi sessions and their background work will stop. Open sessions remain in the workspace as interrupted; resume explicitly afterward.`)) return;
				}
				await launchOperation(location.home, command as Exclude<DeskOperation, "setup">);
				notify("Operation accepted. Use /desk status for its outcome.");
			} catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
			finally { if (!shutdown) ctx.ui.setStatus("desk", undefined); }
		},
	});
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		if (automatic || location.pinned || ctx.mode !== "tui" || process.env.PI_OFFLINE === "1"
			|| process.env.PI_SUBAGENT_TASK_PATH || isManagedChild(pi) || !existsSync(installationFile(location.home))) return;
		automatic = true;
		const previous = operationStatus(location.home);
		if (previous?.phase === "running") return;
		if (previous && previous.phase !== "complete") {
			notify("A Desk operation needs attention. Use /desk status before preparing another update.", "warning"); return;
		}
		void launchOperation(location.home, "stage").catch(error => notify(error instanceof Error ? error.message : String(error), "warning"));
	});
	pi.on("session_shutdown", () => { shutdown = true; initial.abort(); context = undefined; });
}
