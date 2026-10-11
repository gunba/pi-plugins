import type { WorkspaceSession } from "./workspace.ts";

const providerNames: Record<string, string> = { anthropic: "Anthropic", "openai-codex": "ChatGPT (Codex)", openai: "OpenAI", google: "Google" };
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export interface ModelChoice { model: string; reasoning: string }
const key = (computer: string | undefined) => `pi-desk:new-conversation-model:${computer ?? "local"}`;

/** The last model chosen for new conversations on this computer, so it need not be picked again. */
export function rememberedModel(computer: string | undefined): ModelChoice {
	try { const value = JSON.parse(localStorage.getItem(key(computer)) ?? "{}"); return { model: String(value.model ?? ""), reasoning: String(value.reasoning ?? "") }; }
	catch { return { model: "", reasoning: "" }; }
}
export function rememberModel(computer: string | undefined, choice: ModelChoice): void { localStorage.setItem(key(computer), JSON.stringify(choice)); }

/** Model and reasoning for a new conversation, from models a running conversation on that computer reports. */
export function NewConversationModel({ sessions, computer, value, change, disabled }: {
	sessions: WorkspaceSession[]; computer?: string; value: ModelChoice; change: (value: ModelChoice) => void; disabled: boolean;
}) {
	const source = sessions.find(session => (computer === undefined || session.computer === computer) && session.snapshot?.models.length)?.snapshot;
	if (!source) return null;
	const fallback = source.defaultModel && source.models.find(model => model.provider === source.defaultModel!.provider && model.id === source.defaultModel!.id);
	const providers = [...new Set(source.models.map(model => model.provider))];
	const known = !value.model || source.models.some(model => `${model.provider}/${model.id}` === value.model);
	return <div className="new-model-fields">
		<label>Model
			<select value={known ? value.model : ""} disabled={disabled} onChange={event => change({ ...value, model: event.target.value })}>
				<option value="">Computer default{fallback ? ` (${fallback.name})` : ""}</option>
				{providers.map(provider => <optgroup key={provider} label={providerNames[provider] ?? provider}>
					{source.models.filter(model => model.provider === provider).map(model =>
						<option key={model.id} value={`${model.provider}/${model.id}`}>{model.name}</option>)}
				</optgroup>)}
			</select>
		</label>
		<label>Reasoning
			<select value={value.reasoning} disabled={disabled} onChange={event => change({ ...value, reasoning: event.target.value })}>
				<option value="">Model default</option>
				{LEVELS.map(level => <option key={level} value={level}>{level === "xhigh" ? "Extra high" : level[0]!.toUpperCase() + level.slice(1)}</option>)}
			</select>
		</label>
	</div>;
}
