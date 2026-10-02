import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Icon } from "./icons.tsx";

export function ConversationTitle({ title, disabled, rename, control }: {
	title: string; disabled?: boolean; rename: (name: string) => Promise<unknown>; control?: Ref<{ edit: () => void }>;
}) {
	const [editing, setEditing] = useState(false), [draft, setDraft] = useState(title);
	const [saving, setSaving] = useState(false), [error, setError] = useState("");
	const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null);
	useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
	useImperativeHandle(control, () => ({ edit: () => { if (!disabled) { setDraft(title); setEditing(true); } } }), [title, disabled]);
	const cancel = () => { setEditing(false); setError(""); requestAnimationFrame(() => trigger.current?.focus()); };
	const save = async () => {
		if (saving || disabled || !draft.trim()) return;
		setSaving(true); setError("");
		try { await rename(draft.trim()); cancel(); }
		catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setSaving(false); }
	};
	return editing ? <div className="title-editor">
		<form onSubmit={event => { event.preventDefault(); void save(); }}>
			<input ref={input} aria-label="Conversation name" maxLength={300} value={draft} disabled={saving || disabled}
				onChange={event => setDraft(event.target.value)}
				onKeyDown={event => { if (event.key === "Escape" && !saving) { event.preventDefault(); event.stopPropagation(); cancel(); } }} />
			<button type="submit" className="icon-button" aria-label="Save conversation name" title="Save name (Enter)" disabled={saving || disabled || !draft.trim()}><Icon name="check" /></button>
			<button type="button" className="icon-button" aria-label="Cancel rename" title="Cancel (Escape)" disabled={saving} onClick={cancel}><Icon name="close" /></button>
		</form>
		{error && <small role="alert" className="error-text">{error}</small>}
	</div> : <button type="button" ref={trigger} className="conversation-title" disabled={disabled}
		aria-label={`Rename conversation: ${title}`} title="Rename conversation"
		onClick={() => { setDraft(title); setEditing(true); }}>
		<strong>{title}</strong><Icon name="edit" />
	</button>;
}
