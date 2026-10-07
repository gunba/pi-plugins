import { useLayoutEffect, useState } from "react";
import { useAnchoredPopover } from "./anchored-popover.ts";
import type { SessionSnapshot, WorkerCommand } from "../shared/protocol.ts";
import { Icon, ProviderIcon } from "./icons.tsx";
import { useConfirmation } from "./confirmation.tsx";
type ModelContext = Extract<WorkerCommand, { kind: "model" }>["context"];

type Model = SessionSnapshot["models"][number];
const modelKey = (model: Model) => `${model.provider}:${model.id}`;
const providerNames: Record<string, string> = {
	anthropic: "Anthropic", "openai-codex": "OpenAI Codex", openai: "OpenAI API",
	google: "Google", "google-gemini-cli": "Google Gemini", "github-copilot": "GitHub Copilot",
};
export function ModelPicker({ snapshot, disabled, select, accounts, history }: {
	snapshot: Pick<SessionSnapshot, "id" | "leaf" | "activity" | "model" | "models" | "accounts" | "modelSwitchConstraint">; disabled: boolean; select: (model: Model, context?: ModelContext) => void;
	accounts: (provider: string) => void; history: () => void;
}) {
	const [query, setQuery] = useState(""), [active, setActive] = useState("");
	const selected = snapshot.model, constraint = snapshot.modelSwitchConstraint;
	const popover = useAnchoredPopover(`${snapshot.id}/${selected?.provider}/${selected?.id}`, disabled);
	const { id: menuId, trigger, panel: menu, open, close } = popover;
	const contextAware = constraint !== undefined;
	const accountName = (model: Model) => model.accountName ?? (snapshot.accounts === undefined ? "Account unavailable"
		: snapshot.accounts[model.provider] && snapshot.accounts[model.provider] !== "pi" ? "Saved account" : "Pi credentials");
	const provider = selected?.provider ?? "", label = providerNames[provider] ?? provider;
	const reason = (model: Model): string | undefined => {
		if (selected && model.provider !== provider && !contextAware) return "Restart this conversation when idle to switch providers.";
		if (constraint && constraint.provider !== model.provider) {
			if (!constraint.portable) return constraint.reason;
			if (snapshot.activity !== "idle") return "Finish current work before summarizing and switching providers.";
		}
	};
	const filtered = snapshot.models.filter(model => `${model.name} ${model.id} ${providerNames[model.provider] ?? model.provider}`.toLowerCase().includes(query.trim().toLowerCase()));
	const groups = new Map<string, Model[]>();
	for (const model of filtered) {
		const group = groups.get(model.provider) ?? [];
		group.push(model); groups.set(model.provider, group);
	}
	const available = filtered.filter(model => !reason(model));
	const current = available.find(model => modelKey(model) === active) ?? available.find(model => selected && modelKey(model) === modelKey(selected)) ?? available[0];
	const optionId = (model: Model) => `${menuId}-${encodeURIComponent(modelKey(model))}`;
	useLayoutEffect(() => {
		if (!open || !current) return;
		const list = menu.current?.querySelector<HTMLElement>(".model-menu-list"), option = document.getElementById(optionId(current));
		if (!list || !option) return;
		const bounds = list.getBoundingClientRect(), row = option.getBoundingClientRect();
		if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
		else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
	}, [open, query, current && modelKey(current)]);
	const confirmation = useConfirmation(`${snapshot.id}/${snapshot.leaf}/${provider}/${selected?.id}`);
	const choose = async (model: Model) => {
		if (disabled || reason(model)) return;
		close();
		if (selected && modelKey(model) === modelKey(selected)) return;
		if (model.provider === provider || !selected) { select(model); return; }
		const portable = !!constraint && constraint.provider !== model.provider;
		if (portable && (!constraint.portable || !snapshot.leaf)) return;
		const accepted = await confirmation.request({ title: portable ? "Summarize and switch model?" : "Switch model provider?",
			context: `${selected.name} → ${model.name}`, accept: portable ? "Summarize and switch" : "Switch model",
			body: <>
				<p>{portable ? "Codex will make a plain-text summary using the current account’s allowance. The new model will receive that summary, not the encrypted checkpoint. A summary can omit details."
					: "Pi will carry the current text, tool results and supported attachments into the new model. Provider-specific reasoning state and cache do not transfer."}</p>
				<p>The original history stays saved. Tools will not be replayed. Existing subagents keep their own model and account.</p>
				<p>Destination account: <strong>{accountName(model)}</strong> ({providerNames[model.provider] ?? model.provider}).</p>
				{!portable && snapshot.activity === "running" && <p>Current work will stop and continue with the new model.</p>}
			</> });
		if (accepted) select(model, portable ? { mode: "portable", leaf: snapshot.leaf! } : undefined);
	};
	return <div className="model-picker-group">
		<button ref={trigger} type="button" className="model-picker" disabled={disabled} popoverTarget={menuId}
			aria-label={`Choose model${selected ? `: ${selected.name}` : ""}`} aria-haspopup="dialog" aria-expanded={open}
			title={selected ? `${label} · ${selected.id} · ${accountName(selected)}` : "Choose a model"}>
			<ProviderIcon id={provider} title={label} /><span>{selected?.name ?? "Choose model"}</span>
			<svg className="model-picker-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
		</button>
		<div ref={menu} id={menuId} popover="auto" className="model-menu" role="dialog" aria-label="Choose a model"
			onBeforeToggle={event => { popover.beforeToggle(event); if (event.newState === "open") { setQuery(""); setActive(selected ? modelKey(selected) : ""); } }}
			onToggle={popover.toggle} onKeyDown={popover.keyDown}>
			<div className="model-menu-search"><input data-autofocus type="search" form="" role="combobox" aria-label="Find a model" placeholder="Find a model…" value={query}
				aria-expanded={open} aria-controls={`${menuId}-list`} aria-autocomplete="list" aria-activedescendant={open && current ? optionId(current) : undefined}
				onChange={event => { setQuery(event.currentTarget.value); setActive(""); }} onKeyDown={event => {
					if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault(); const index = current ? available.indexOf(current) : -1;
						const next = available[(index + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length];
						if (next) setActive(modelKey(next));
					} else if (event.key === "Enter") { event.preventDefault(); if (current) void choose(current); }
				}} /></div>
			<div className="model-menu-list" id={`${menuId}-list`} role="listbox" aria-label="Models">
				{[...groups].map(([provider, models]) => <div role="group" aria-label={providerNames[provider] ?? provider} key={provider}>
					<div className="model-menu-provider" aria-hidden="true"><ProviderIcon id={provider} title={providerNames[provider] ?? provider} /><span>{providerNames[provider] ?? provider}</span></div>
					{models.map(model => <button type="button" role="option" id={optionId(model)} key={model.id} tabIndex={-1}
						className={`model-menu-option${current && modelKey(current) === modelKey(model) ? " is-active" : ""}`}
						aria-selected={!!selected && modelKey(model) === modelKey(selected)} aria-disabled={!!reason(model)}
						title={reason(model) ?? `${model.provider}/${model.id} · ${accountName(model)}`}
						onClick={() => void choose(model)} onMouseMove={() => { if (!reason(model)) setActive(modelKey(model)); }}>
						<span>{model.name}</span>{selected && modelKey(model) === modelKey(selected) && <Icon name="check" />}
					</button>)}
				</div>)}
				{!filtered.length && <p className="model-menu-empty">No matching models</p>}
			</div>
			<div className="model-menu-footer">
				<div className="model-menu-account"><span title={selected ? `${label} · ${accountName(selected)}` : undefined}>{label}{selected && ` · ${accountName(selected)}`}</span>
					<button type="button" disabled={!selected} onClick={() => { close(); accounts(provider); }}>Accounts</button></div>
				{!contextAware && selected && snapshot.models.some(model => model.provider !== provider) && <p>Restart this conversation when idle to switch providers. Current work can keep running.</p>}
				{constraint && <p>{constraint.portable ? "Encrypted Codex context needs a summary before switching providers. Choose a model when idle to continue." : constraint.reason} <button type="button" onClick={() => { close(); history(); }}>History</button></p>}
			</div>
		</div>
		{confirmation.dialog}
	</div>;
}
