import type { SessionSnapshot, WorkerCommand } from "../shared/protocol.ts";
import { ProviderIcon } from "./icons.tsx";
import { useConfirmation } from "./confirmation.tsx";
type ModelContext = Extract<WorkerCommand, { kind: "model" }>["context"];

type Model = SessionSnapshot["models"][number];
const providerNames: Record<string, string> = {
	anthropic: "Anthropic", "openai-codex": "OpenAI Codex", openai: "OpenAI API",
	google: "Google", "google-gemini-cli": "Google Gemini", "github-copilot": "GitHub Copilot",
};
export function ModelPicker({ snapshot, disabled, select, accounts, history }: {
	snapshot: Pick<SessionSnapshot, "id" | "leaf" | "activity" | "model" | "models" | "accounts" | "modelSwitchConstraint">; disabled: boolean; select: (model: Model, context?: ModelContext) => void;
	accounts: (provider: string) => void; history: () => void;
}) {
	const groups = new Map<string, Model[]>();
	for (const model of snapshot.models) {
		const group = groups.get(model.provider) ?? [];
		group.push(model); groups.set(model.provider, group);
	}
	const selected = snapshot.model, constraint = snapshot.modelSwitchConstraint;
	const contextAware = constraint !== undefined;
	const accountName = (model: Model) => model.accountName ?? (snapshot.accounts === undefined ? "Account unavailable"
		: snapshot.accounts[model.provider] && snapshot.accounts[model.provider] !== "pi" ? "Saved account" : "Pi credentials");
	const provider = selected?.provider ?? "", label = providerNames[provider] ?? provider;
	const confirmation = useConfirmation(`${snapshot.id}/${snapshot.leaf}/${provider}/${selected?.id}`);
	const choose = async (model: Model) => {
		if (model.provider === provider || !selected) { select(model); return; }
		if (!contextAware) return;
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
		<div className="model-picker" data-provider={provider}>
			<button type="button" className="model-account-button" disabled={disabled || !selected}
				aria-label={`Model accounts for ${label}`} title={`${label} · ${selected ? accountName(selected) : "Account unavailable"}`} onClick={() => accounts(provider)}>
				<ProviderIcon id={provider} title={label} />
			</button>
			<label className="model-picker-label">
				<span className="model-picker-identity">{label}<span> · {selected ? accountName(selected) : "Account unavailable"}</span></span>
				<select aria-label="Model" title={selected ? `${provider}/${selected.id} · ${accountName(selected)} · Changing model stops active work and continues with the new setting` : "Choose a model"} disabled={disabled}
					value={selected ? `${provider}:${selected.id}` : ""} onChange={event => {
						const model = snapshot.models.find(model => `${model.provider}:${model.id}` === event.target.value);
						if (model) void choose(model);
					}}>
					{!selected && <option value="">Choose a model</option>}
					{[...groups].map(([provider, models]) => <optgroup key={provider} label={providerNames[provider] ?? provider}>
						{models.map(model => <option key={model.id} value={`${provider}:${model.id}`}
							disabled={provider !== selected?.provider && !contextAware || !!constraint && constraint.provider !== provider && (!constraint.portable || snapshot.activity !== "idle")} title={constraint && constraint.provider !== provider ? constraint.portable ? "Summarize with Codex, then switch when idle" : constraint.reason : `${provider}/${model.id}`} >
							{model.name}
						</option>)}
					</optgroup>)}
				</select>
			</label>
		</div>
		{!contextAware && <details className="model-switch-note"><summary>Provider switching needs a newer worker</summary>
			<p>Restart this conversation when idle to enable cross-provider switching. Current work can keep running.</p>
		</details>}
		{constraint && <details className="model-switch-note"><summary>Codex checkpoint · switching providers</summary>
			<p>{constraint.portable ? "Choose another provider to summarize the current context with Codex, then switch. Finish current work first. You can also branch from an earlier point." : constraint.reason} <button type="button" disabled={disabled} onClick={history}>History</button></p>
		</details>}
		{confirmation.dialog}
	</div>;
}
