import { useState } from "react";
import type { ModelCallsView, ModelOption, ModelProvider } from "../shared/services.ts";
import { api } from "./connection.ts";
import { Row } from "./settings-pages.tsx";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const price = (value: number) => "$" + value.toLocaleString(undefined, { maximumFractionDigits: 3 });
const dollars = (value: number) => "$" + value.toFixed(2);
const effortLabel = (effort: string) => effort === "off" ? "no reasoning" : effort + " effort";
const preferredEffort = (efforts: string[]) => efforts.includes("medium") ? "medium" : efforts[0] ?? "off";

/**
 * Settings → Accounts & connections: the model, effort, API key and daily limit for ask_model on one computer.
 * Providers load when choosing starts and each provider's models when it is picked, because the whole catalog is large.
 */
export function ModelCalls({ computer, name, connected, view, saved }: {
	computer?: string; name: string; connected: boolean; view: ModelCallsView; saved: (view: ModelCallsView) => void;
}) {
	const [providers, setProviders] = useState<ModelProvider[]>(), [models, setModels] = useState<Record<string, ModelOption[]>>({});
	const [editing, setEditing] = useState(false), [working, setWorking] = useState(false);
	const [provider, setProvider] = useState(""), [model, setModel] = useState(""), [effort, setEffort] = useState("");
	const [key, setKey] = useState(""), [limit, setLimit] = useState(""), [error, setError] = useState("");
	const pick = async (id: string | undefined, modelId?: string, effortId?: string) => {
		setProvider(id ?? ""); setModel(""); setError("");
		if (!id) return;
		try {
			const list = models[id] ?? await api<ModelOption[]>("/services/models?provider=" + encodeURIComponent(id), undefined, computer);
			setModels(value => ({ ...value, [id]: list }));
			choose(list, modelId, effortId);
		} catch (error) { setError(message(error)); }
	};
	const choose = (list: ModelOption[], modelId?: string, effortId?: string) => {
		const entry = list.find(item => item.id === modelId) ?? list[0];
		setModel(entry?.id ?? "");
		setEffort(entry && effortId && entry.efforts.includes(effortId) ? effortId : preferredEffort(entry?.efforts ?? []));
	};
	const open = async () => {
		setEditing(true); setError(""); setKey(""); setLimit(String(view.dailyLimit));
		try {
			const list = providers ?? await api<ModelProvider[]>("/services/models", undefined, computer);
			setProviders(list);
			const start = list.find(item => item.provider === view.provider) ?? list.find(item => item.provider === "openai") ?? list[0];
			await pick(start?.provider, view.model, view.effort);
		} catch (error) { setError(message(error)); }
	};
	const save = async (body: Record<string, unknown>) => {
		setWorking(true); setError("");
		try { saved(await api<ModelCallsView>("/services/models", body, computer)); setEditing(false); setKey(""); }
		catch (error) { setError(message(error)); }
		finally { setWorking(false); }
	};
	const list = models[provider], entry = list?.find(item => item.id === model);
	const keySaved = view.key && provider === view.provider, disabled = !connected || working;
	return <>
		<Row label="Model calls" hint={"Programs on " + name + " call tools.ask_model for free-text answers. Each call is billed to this API key at the provider's prices, never to a subscription sign-in, and calls stop for the day (UTC) at the daily limit. Applies to every conversation on " + name + "."}>
			<span className="muted">{view.provider ? view.provider + "/" + view.model + " · " + effortLabel(view.effort!) + " · " + dollars(view.spentToday) + " of " + dollars(view.dailyLimit) + " today" : "Not set up"}</span>
			{!editing && <button disabled={disabled} onClick={() => void open()}>{view.provider ? "Change" : "Choose model"}</button>}
			{!editing && view.provider && <button className="quiet-action" disabled={disabled} onClick={() => void save({ remove: true })}>Remove</button>}
		</Row>
		{editing && <Row label="">
			<form className="settings-inline-form model-calls-form" onSubmit={event => {
				event.preventDefault();
				void save({ provider, model, effort, dailyLimit: Number(limit), ...key.trim() ? { key: key.trim() } : {} });
			}}>
				<select aria-label="Provider" value={provider} disabled={disabled || !providers} onChange={event => void pick(event.target.value)}>
					{!providers && <option value="">Loading…</option>}
					{providers?.map(item => <option key={item.provider} value={item.provider}>{item.name}</option>)}
				</select>
				<select aria-label="Model" value={model} disabled={disabled || !list} onChange={event => choose(list ?? [], event.target.value, effort)}>
					{!list && <option value="">Loading…</option>}
					{list?.map(item => <option key={item.id} value={item.id}>{item.name + " · " + price(item.input) + " / " + price(item.output) + " per M"}</option>)}
				</select>
				<select aria-label="Effort" value={effort} disabled={disabled || !entry} onChange={event => setEffort(event.target.value)}>
					{entry?.efforts.map(item => <option key={item} value={item}>{effortLabel(item)}</option>)}
				</select>
				<input type="password" aria-label={(providers?.find(item => item.provider === provider)?.name ?? "Provider") + " API key"} autoComplete="off" spellCheck={false}
					maxLength={2000} value={key} placeholder={keySaved ? "Key saved; paste to replace" : "Paste API key"} disabled={disabled} onChange={event => setKey(event.target.value)} />
				<label className="model-calls-limit">$<input type="number" aria-label="Daily limit in USD" min="0.01" max="10000" step="any" required
					value={limit} disabled={disabled} onChange={event => setLimit(event.target.value)} />a day</label>
				<button type="submit" disabled={disabled || !entry || !limit || (!keySaved && !key.trim())}>Save</button>
				<button type="button" className="quiet-action" disabled={working} onClick={() => { setEditing(false); setError(""); }}>Cancel</button>
			</form>
		</Row>}
		{error && <Row label=""><span className="error-text" role="alert">{error}</span></Row>}
	</>;
}
