import { useEffect, useState } from "react";
import type { UiAnswer } from "../../../pi-ui/index.ts";
import type { InteractionSnapshot } from "../shared/protocol.ts";
import { Icon } from "./icons.tsx";

export type SettingsDraft = { choices: string[]; text: string; freeform: boolean };
/** Native settings interactions are controls, not agent questions. */
export function SettingsForm({ interaction, disabled, draftKey, drafts, answer }: {
	interaction: InteractionSnapshot; disabled: boolean; draftKey: string; drafts: Map<string, SettingsDraft>;
	answer: (answer: UiAnswer | null) => Promise<unknown>;
}) {
	const form = interaction.form, saved = drafts.get(draftKey);
	const [choices, setChoices] = useState(saved?.choices ?? []);
	const [text, setText] = useState(saved?.text ?? (form.kind === "editor" ? form.value ?? "" : ""));
	const [freeform, setFreeform] = useState(saved?.freeform ?? false);
	const [busy, setBusy] = useState(false), [error, setError] = useState("");
	useEffect(() => { drafts.set(draftKey, { choices, text, freeform }); }, [draftKey, drafts, choices, text, freeform]);
	const submit = async (value: UiAnswer | null) => {
		if (busy) return; setBusy(true); setError("");
		try { await answer(value); }
		catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false); }
	};
	const context = form.kind === "confirm" ? form.message : form.context;
	const blocked = disabled || busy;
	return <section className="panel-card settings-form" data-settings-form={interaction.id}>
		<h3><Icon name="settings" />{form.title}</h3>
		{interaction.scope && <p className="muted">{interaction.scope.label}</p>}
		{context && <p className="detail-copy">{context}</p>}
		{"links" in form && form.links?.map(link => <a className="quiet-action" key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label} ↗</a>)}
		<form onSubmit={event => {
			event.preventDefault();
			void submit(form.kind === "confirm" ? { kind: "confirm", confirmed: true }
				: form.kind === "question" && !freeform ? { kind: "selection", selections: choices, ...(form.allowComment && text ? { comment: text } : {}) }
				: { kind: "freeform", text });
		}}>
			{form.kind === "question" && <>
				{!freeform && <fieldset disabled={blocked}><legend>Choose {form.allowMultiple ? "one or more options" : "an option"}</legend>
					{form.options.map(option => <label className="settings-form-option" key={option.title}>
						<input type={form.allowMultiple ? "checkbox" : "radio"} name={interaction.id} checked={choices.includes(option.title)} onChange={event => setChoices(form.allowMultiple
							? event.target.checked ? [...choices, option.title] : choices.filter(value => value !== option.title) : [option.title])} />
						<span>{option.title}{option.description && <small>{option.description}</small>}</span>
					</label>)}
				</fieldset>}
				{form.allowFreeform && <label className="settings-form-option"><input type="checkbox" checked={freeform} disabled={blocked} onChange={event => setFreeform(event.target.checked)} />Enter a different value</label>}
				{(freeform || form.allowComment) && <label>{freeform ? "Value" : "Comment"}<textarea value={text} disabled={blocked} onChange={event => setText(event.target.value)} /></label>}
			</>}
			{(form.kind === "input" || form.kind === "editor") && <label>{form.kind === "editor" ? "Value" : form.title}
				{form.kind === "editor" ? <textarea rows={8} value={text} disabled={blocked} onChange={event => setText(event.target.value)} />
					: <input value={text} placeholder={form.placeholder} disabled={blocked} onChange={event => setText(event.target.value)} />}
			</label>}
			{error && <p className="error-text" role="alert">{error}</p>}
			<div className="dialog-actions"><button type="button" disabled={blocked} onClick={() => void submit(null)}>Cancel</button>
				<button type="submit" disabled={blocked || form.kind === "question" && (freeform ? !text.trim() : !choices.length)}>{form.kind === "confirm" ? "Confirm" : "Apply"}</button>
			</div>
		</form>
	</section>;
}
