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

function ReasoningMenu({ value, change, disabled, id = "new-conversation-reasoning" }: { value: string; change: (value: string) => void; disabled: boolean; id?: string }) {
	const popover = useAnchoredPopover(id, disabled, 200);
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

/**
 * The model and reasoning a conversation that isn't running resumes with. Changing them opens it to apply the change
 * (change), after which Desk puts it back to sleep. Switching provider needs it open, as its history may have to be
 * summarized first.
 */
export function ResumeModel({ sessions, session, disabled, change }: {
	sessions: WorkspaceSession[]; session: WorkspaceSession; disabled: boolean; change: (value: Partial<ModelChoice>) => void;
}) {
	const source = sessions.find(item => item.computer === session.computer && item.snapshot?.models.length)?.snapshot, last = session.lastModel;
	if (!source || !last) return null;
	const chosen = source.models.find(model => model.provider === last.provider && model.id === last.id);
	return <div className="resume-model">
		<ModelPicker disabled={disabled} select={model => change({ model: `${model.provider}/${model.id}` })}
			snapshot={{ id: `resume:${session.key}`, leaf: null, empty: false, activity: "idle", models: source.models,
				modelSwitchConstraint: { provider: last.provider, portable: false, reason: "Open it to switch provider: its history may need summarizing first." },
				model: { ...(chosen ?? last), images: false } }} />
		<ReasoningMenu id={`resume-reasoning:${session.key}`} value={last.thinking ?? ""} disabled={disabled} change={reasoning => { if (reasoning) change({ reasoning }); }} />
	</div>;
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
				snapshot={{ id: `new:${computer ?? "local"}`, leaf: null, empty: true, activity: "idle", models: source.models,
					modelSwitchConstraint: null, model: chosen ? { ...chosen, images: false } : undefined }} />
		</div>
		<div className="new-model-field"><span>Reasoning</span>
			<ReasoningMenu value={value.reasoning} disabled={disabled} change={reasoning => change({ ...value, reasoning })} />
		</div>
	</div>;
}
