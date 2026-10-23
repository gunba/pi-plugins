import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import type { UiAnswer } from "../../../pi-ui/index.ts";
import type { InteractionSnapshot } from "../shared/protocol.ts";
import { markdownPlugins } from "./markdown-links.ts";
import { ExternalLinks } from "./external-links.tsx";
import { Icon } from "./icons.tsx";
import { Modal } from "./surfaces.tsx";

/** What has been chosen or typed in an unanswered form, kept while it is closed or another one is shown. */
export type InteractionDraft = { choices: string[]; text: string; freeform: boolean };

/**
 * A form Pi is waiting on: an agent's question, or the follow-up form of a settings control (an extension's menu or
 * prompt), which `interaction.settings` marks. Shown inline in the conversation or as a dialog. Cancel answers null.
 */
export function InteractionForm({ interaction, questions = [], choose, owner = "", inline = false, disabled = false, drafts, draftKey, close, answer }: {
	interaction: InteractionSnapshot;
	/** The pending questions, to switch between when there are several. */
	questions?: InteractionSnapshot[]; choose?: (id: string) => void;
	/** Whose question it is: its computer and conversation. */
	owner?: string;
	inline?: boolean; disabled?: boolean;
	drafts: Map<string, InteractionDraft>; draftKey: string;
	/** Closes the dialog. */
	close: () => void;
	answer: (answer: UiAnswer | null) => Promise<unknown>;
}) {
	const form = interaction.form, settings = !!interaction.settings;
	const saved = drafts.get(draftKey);
	const [choices, setChoices] = useState<string[]>(saved?.choices ?? []);
	const [text, setText] = useState(saved?.text ?? (form.kind === "editor" || form.kind === "input" ? form.value ?? "" : ""));
	const [freeform, setFreeform] = useState(saved?.freeform ?? (form.kind !== "question" || !form.options.length));
	useEffect(() => { drafts.set(draftKey, { choices, text, freeform }); }, [drafts, draftKey, choices, text, freeform]);
	const [error, setError] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const blocked = disabled || submitting;
	const submit = async (value: UiAnswer | null) => {
		if (submitting) return;
		setSubmitting(true); setError("");
		try { await answer(value); }
		catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
		finally { setSubmitting(false); }
	};
	const content = <form className="question-form" onSubmit={event => {
		event.preventDefault();
		void submit(form.kind === "confirm" ? { kind: "confirm", confirmed: true }
			: freeform ? { kind: "freeform", text }
			: { kind: "selection", selections: choices, ...(form.kind === "question" && form.allowComment && text ? { comment: text } : {}) });
	}}>
		<div className="question-scroll">
			{owner && <p className="muted question-owner">{owner}</p>}
			{questions.length > 1 && choose && <label>
				{questions.length} pending questions
				<select aria-label="Pending questions" value={interaction.id} onChange={event => choose(event.target.value)}>
					{questions.map(item => <option key={item.id} value={item.id}>{item.form.title}{item.scope ? ` · ${item.scope.label}` : ""}</option>)}
				</select>
			</label>}
			{interaction.scope && <p className="muted">Agent: {interaction.scope.label}</p>}
			{(form.kind === "input" || form.kind === "editor") && <>
				{form.context && <p className="detail-copy">{form.context}</p>}
				<ExternalLinks links={form.links} text={form.context} />
			</>}
			{form.kind === "confirm" ? <div className="request-description" tabIndex={0} aria-label="Request details">{form.message}</div>
			: form.kind === "question" ? <>
				{form.context && <div className="question-context"><Markdown remarkPlugins={markdownPlugins()}>{form.context}</Markdown></div>}
				<div className="choices">
					{form.options.map((option, index) => <label className={`choice ${choices.includes(option.title) && !freeform ? "chosen" : ""}`} key={index}>
						<input type={form.allowMultiple ? "checkbox" : "radio"} name="choice" checked={!freeform && choices.includes(option.title)} onChange={() => {
							setFreeform(false);
							setChoices(form.allowMultiple
								? choices.includes(option.title) ? choices.filter(value => value !== option.title) : [...choices, option.title]
								: [option.title]);
						}} />
						<span><strong>{option.title}</strong>{option.description && <small>{option.description}</small>}</span>
					</label>)}
					{form.allowFreeform && !!form.options.length && <label className={`choice ${freeform ? "chosen" : ""}`}>
						<input type="radio" name="choice" checked={freeform} onChange={() => setFreeform(true)} /><span>Write an answer</span>
					</label>}
				</div>
				{freeform && <textarea data-autofocus aria-label="Your answer" value={text} onChange={event => setText(event.target.value)} placeholder="Your answer…" rows={4} />}
				{form.allowComment && !freeform && <label>
					Comment <span className="muted">(optional)</span>
					<textarea value={text} onChange={event => setText(event.target.value)} rows={2} />
				</label>}
			</>
			: <textarea data-autofocus aria-label={form.title} value={text} onChange={event => setText(event.target.value)} placeholder={form.placeholder}
				rows={form.kind === "editor" ? 14 : 3} />}
			{error && <p className="error-text" role="alert">{error}</p>}
		</div>
		<div className="dialog-actions">
			<button type="button" disabled={blocked} onClick={() => void submit(null)}>Cancel</button>
			<button className="primary" disabled={blocked || form.kind === "question" && (freeform ? !text.trim() : !choices.length)}>
				{form.kind === "confirm" ? "Confirm" : "submitLabel" in form && form.submitLabel ? form.submitLabel
					: settings ? "Apply" : form.kind === "question" ? "Send answer" : "Save"}
			</button>
		</div>
	</form>;
	return inline ? <section className="inline-question" aria-labelledby={`question-${interaction.id}`}>
		<header><Icon name={form.kind === "confirm" ? "check" : "chat"} /><h3 id={`question-${interaction.id}`}>{form.title}</h3></header>
		{content}
	</section> : <Modal className="question-modal" title={form.title || (settings ? "Settings" : "")} close={close}>{content}</Modal>;
}
