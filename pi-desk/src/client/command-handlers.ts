import type { SessionView, WorkerCommand } from "../shared/protocol.ts";
import type { Delivery } from "./composer-keys.ts";
import { api } from "./connection.ts";
import { deliveryModes } from "./delivery-control.tsx";
import { deskCommandCatalog, type DeskCommandHandlers } from "./desk-commands.ts";
import { settingsSections } from "./settings.tsx";

const noArguments = (name: string, args: string) => { if (args) throw Error(`Use /${name} without arguments.`); };
/** Opens the composer's model picker or reasoning select, as the command's choice. */
function openPicker(label: string) {
	const picker = label === "Model" ? document.querySelector<HTMLButtonElement>("button.model-picker")
		: document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
	if (!picker || picker.disabled) throw Error("This choice is unavailable while the current operation is pending.");
	picker.focus();
	if (picker instanceof HTMLSelectElement) picker.showPicker?.(); else picker.click();
}

/** The slash commands Desk runs itself in the selected conversation, alongside Pi's native ones. */
export function deskCommandHandlers({ session, key, command, delivery, openSettings, newConversation, resume, editTitle, accounts, show }: {
	session?: SessionView;
	/** The selected conversation's key. */
	key: string;
	command: <T = unknown>(command: WorkerCommand) => Promise<T>;
	delivery: Delivery;
	openSettings: (section: string) => void;
	newConversation: (folder?: string) => void;
	/** Opens Resume: "switch" switches this conversation to a saved session. */
	resume: (mode: true | "switch") => void;
	editTitle: () => void;
	accounts: (provider: string) => void;
	show: (title: string, text: string) => void;
}): DeskCommandHandlers {
	const rename = async (args: string) => {
		if (session?.state !== "ready") throw Error("Wait for Pi to finish opening this conversation before renaming it.");
		if (args) await command({ kind: "name", name: args }); else editTitle();
	};
	const handlers: DeskCommandHandlers = {
		settings: { description: "Open Settings; optionally choose a section.", execute: args => {
			const section = args || (session ? "conversation" : "general");
			if (!settingsSections.some(item => item.id === section)) throw Error(`Choose a settings section: ${settingsSections.map(item => item.id).join(", ")}.`);
			openSettings(section);
		} },
		new: { description: "Start a fresh session in this conversation, or /new <folder> for a new conversation there.", execute: args => {
			// Like Pi: a new session in the running process, without starting another. Older workers lack the adapter.
			if (!args && session?.snapshot?.commands.some(item => item.name === "new" && item.execution === "control"))
				return command({ kind: "native", name: "new", args: "" });
			newConversation(args || undefined);
		} },
		resume: { description: "Switch this conversation to a saved session.", execute: args => { noArguments("resume", args); resume(session?.state === "ready" ? "switch" : true); } },
		name: { description: "Rename this conversation.", execute: rename },
		rename: { description: "Alias for /name.", execute: rename },
		compact: { description: "Compact native context.", execute: args => command({ kind: "compact", instructions: args || undefined }) },
		reload: { description: "Reload native resources.", execute: args => { noArguments("reload", args); return command({ kind: "reload" }); } },
		fork: { description: "Choose a branch entry, or /fork <entry-id> [at|before].", execute: args => {
			if (!args) { openSettings("conversation"); return; }
			const [entry, position = "at", extra] = args.split(/\s+/);
			if (extra || !["at", "before"].includes(position)) throw Error("Use /fork <entry-id> [at|before].");
			return command({ kind: "fork", entry, position: position as "at" | "before" });
		} },
		tree: { description: "Open native branch history.", execute: args => { noArguments("tree", args); openSettings("conversation"); } },
		model: { description: "Choose a model.", argumentHint: "<provider/model>", execute: args => {
			if (!args) { openPicker("Model"); return; }
			if (session?.snapshot?.commands.some(item => item.name === "model" && item.execution === "control"))
				return command({ kind: "native", name: "model", args });
			const matches = session?.snapshot?.models.filter(model => `${model.provider}/${model.id}` === args || model.id === args) ?? [];
			if (matches.length !== 1) throw Error("Choose an exact provider/model from this worker's model picker.");
			return command({ kind: "model", provider: matches[0].provider, id: matches[0].id });
		} },
		thinking: { description: "Choose a reasoning level.", argumentHint: "<level>", execute: args => {
			if (!args) { openPicker("Reasoning level"); return; }
			return command({ kind: "thinking", level: args.toLowerCase() });
		} },
		login: { description: "Sign Pi in to a provider (Settings → Accounts & connections).", argumentHint: "<provider>", execute: accounts },
		logout: { description: "Sign Pi out of a provider (Settings → Accounts & connections).", execute: args => { noArguments("logout", args); accounts(""); } },
		copy: { description: "Copy the latest assistant text.", execute: async args => {
			noArguments("copy", args);
			if (!session?.snapshot?.commands.some(item => item.name === "copy" && item.execution === "read")) throw Error("This worker has no native clipboard-text adapter.");
			const value = await command<{ result: string }>({ kind: "native_read", name: "copy", args: "" });
			if (!value.result) throw Error("There is no assistant text to copy.");
			await navigator.clipboard.writeText(value.result);
		} },
		quit: { description: "Close this conversation, preserving its history.", execute: async args => {
			noArguments("quit", args);
			if (!session?.activation) throw Error("This conversation is not open.");
			await api(`/sessions/${key}/close`, { id: crypto.randomUUID(), activation: session.activation });
		} },
		hotkeys: { description: "Show Desk keyboard shortcuts.", execute: args => {
			noArguments("hotkeys", args);
			show("Keyboard shortcuts", `Enter — ${deliveryModes.find(mode => mode.value === delivery)!.label} (choose with the arrow beside Send)\nCtrl+Enter — interrupt and send\nAlt+Enter / Ctrl+Q — queue a follow-up\nShift+Enter / Ctrl+J — new line\nTab — complete a slash command\nUp / Down — choose a completion\nEsc — dismiss completion or dialog`);
		} },
		help: { description: "Show commands for this conversation.", execute: args => {
			noArguments("help", args);
			const catalog = deskCommandCatalog(session?.snapshot?.commands ?? [], handlers);
			show("Commands", catalog.map(item => `/${item.name}${item.argumentHint ? ` ${item.argumentHint}` : ""} — ${item.unavailable ?? item.description}`).join("\n"));
		} },
	};
	return handlers;
}
