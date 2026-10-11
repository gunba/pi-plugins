import type { WorkspaceSession } from "./workspace.ts";
import { ModelPicker } from "./model-picker.tsx";
import { useAnchoredPopover } from "./anchored-popover.ts";
import { Icon } from "./icons.tsx";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const levelName = (level: string) => level === "xhigh" ? "Extra high" : level ? level[0]!.toUpperCase() + level.slice(1) : "Model default";
export interface ModelChoice { model: string; reasoning: string }
const key = (computer: string | undefined) => `pi-desk:new-conversation-model:${computer ?? "local"}`;

/** The last model chosen for new conversations on this computer, so it need not be picked again. */
export function rememberedModel(computer: string | undefined): ModelChoice {
	try { const value = JSON.parse(localStorage.getItem(key(computer)) ?? "{}"); return { model: String(value.model ?? ""), reasoning: String(value.reasoning ?? "") }; }
	catch { return { model: "", reasoning: "" }; }
}
export function rememberModel(computer: string | undefined, choice: ModelChoice): void { localStorage.setItem(key(computer), JSON.stringify(choice)); }

function ReasoningMenu({ value, change, disabled }: { value: string; change: (value: string) => void; disabled: boolean }) {
	const popover = useAnchoredPopover("new-conversation-reasoning", disabled, 200);
	return <>
		<button ref={popover.trigger} type="button" className="field-picker" disabled={disabled} popoverTarget={popover.id}
			aria-haspopup="listbox" aria-expanded={popover.open} aria-label={`Reasoning: ${levelName(value)}`}>
			<span>{levelName(value)}</span>
			<svg className="model-picker-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
		</button>
		<div ref={popover.panel} id={popover.id} popover="auto" className="model-menu" role="listbox" aria-label="Reasoning level"
			onBeforeToggle={popover.beforeToggle} onToggle={popover.toggle} onKeyDown={popover.keyDown}>
			{popover.open && <div className="model-menu-list">{["", ...LEVELS].map(level => <button type="button" role="option" key={level || "default"}
				className="model-menu-option" aria-selected={level === value} data-autofocus={level === value || undefined}
				onClick={() => { popover.close(); change(level); }}>
				<span>{levelName(level)}</span>{level === value && <Icon name="check" />}</button>)}</div>}
		</div>
	</>;
}

/** Model and reasoning for a new conversation, chosen with the same picker as the composer. */
export function NewConversationModel({ sessions, computer, value, change, disabled }: {
	sessions: WorkspaceSession[]; computer?: string; value: ModelChoice; change: (value: ModelChoice) => void; disabled: boolean;
}) {
	const source = sessions.find(session => (computer === undefined || session.computer === computer) && session.snapshot?.models.length)?.snapshot;
	if (!source) return null;
	const find = (provider?: string, id?: string) => source.models.find(model => model.provider === provider && model.id === id);
	const [provider, id] = value.model.split(/\/(.*)/s);
	const chosen = find(provider, id) ?? (source.defaultModel ? find(source.defaultModel.provider, source.defaultModel.id) : undefined);
	return <div className="new-model-fields">
		<div className="new-model-field"><span>Model</span>
			<ModelPicker disabled={disabled} select={model => change({ ...value, model: `${model.provider}/${model.id}` })}
				// Nothing to carry over yet, so any model can be chosen without a provider-switch warning.
				snapshot={{ id: `new:${computer ?? "local"}`, leaf: null, empty: true, activity: "idle", models: source.models, accounts: source.accounts,
					modelSwitchConstraint: null, model: chosen ? { ...chosen, images: false } : undefined }} />
		</div>
		<div className="new-model-field"><span>Reasoning</span>
			<ReasoningMenu value={value.reasoning} disabled={disabled} change={reasoning => change({ ...value, reasoning })} />
		</div>
	</div>;
}
