import { useEffect, useRef, useState } from "react";
import type { ContextChange, ContextFile, ContextSnapshot } from "../shared/context.ts";
import type { SessionView, WorkerCommand } from "../shared/protocol.ts";
import type { ControlStatus } from "../shared/controls.ts";
import { Icon } from "./icons.tsx";

const name = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
export function ContextPanel({ session, disabled, invoke }: { session: SessionView; disabled: boolean; invoke: (command: WorkerCommand) => Promise<unknown> }) {
	const [data, setData] = useState<ContextSnapshot>(), [error, setError] = useState(""), [pending, setPending] = useState(false);
	const [tab, setTab] = useState("instructions"), [query, setQuery] = useState(""), [file, setFile] = useState<ContextFile>(), [draft, setDraft] = useState("");
	const current = useRef(""), read = useRef(0), request = useRef(0), call = useRef(invoke); call.current = invoke;
	const statuses = useRef(session.controls); statuses.current = session.controls;
	const waiting = useRef<{ id: string; resolve: () => void; reject: (error: Error) => void } | undefined>(undefined);
	const scope = `${session.key}:${session.ui?.generation}`; current.current = scope;
	const completed = (control: ControlStatus) => {
		if (control.state !== "completed") throw Error(control.error ?? `Context change ${control.state}. Check Recent operations before retrying.`);
	};
	useEffect(() => {
		const pending = waiting.current, control = pending && session.controls?.find(item => item.id === pending.id);
		if (!pending || !control || control.state === "running") return;
		waiting.current = undefined;
		try { completed(control); pending.resolve(); } catch (error) { pending.reject(error as Error); }
	}, [session.controls]);
	const apply = async (command: WorkerCommand) => {
		const { result } = await call.current(command) as { result: { control: ControlStatus } };
		if (current.current !== scope) throw Error("The context view changed.");
		const control = statuses.current?.find(item => item.id === result.control.id) ?? result.control;
		if (control.state !== "running") { completed(control); return; }
		await new Promise<void>((resolve, reject) => { waiting.current = { id: control.id, resolve, reject }; });
	};
	const refresh = async () => {
		const id = ++request.current; setPending(true); setError("");
		try { const { result } = await call.current({ kind: "context_inspect" }) as { result: ContextSnapshot };
			if (current.current === scope && request.current === id) setData(result); }
		catch (error) { if (current.current === scope && request.current === id) setError(String(error)); }
		finally { if (current.current === scope && request.current === id) setPending(false); }
	};
	useEffect(() => {
		current.current = scope; setData(undefined); setFile(undefined); setDraft(""); void refresh();
		return () => {
			current.current = ""; read.current++; request.current++;
			waiting.current?.reject(Error("The context view changed.")); waiting.current = undefined;
		};
	}, [scope]);
	const change = async (value: Omit<ContextChange, "revision">) => {
		if (!data || pending) return;
		setPending(true); setError("");
		try { await apply({ kind: "context_update", ...value, revision: data.revision }); if (current.current === scope) await refresh(); }
		catch (error) { if (current.current === scope) setError(String(error)); }
		finally { if (current.current === scope) setPending(false); }
	};
	const edit = async (path: string) => {
		const request = ++read.current; setPending(true); setError("");
		try { const { result } = await call.current({ kind: "context_read", path }) as { result: ContextFile };
			if (current.current === scope && read.current === request) { setFile(result); setDraft(result.text); }
		} catch (error) { if (current.current === scope && read.current === request) setError(String(error)); }
		finally { if (current.current === scope && read.current === request) setPending(false); }
	};
	const save = async () => {
		if (!file || pending) return;
		setPending(true); setError("");
		try { await apply({ kind: "context_save", path: file.path, version: file.version, text: draft });
			if (current.current === scope) { setFile(undefined); await refresh(); }
		} catch (error) { if (current.current === scope) setError(String(error)); }
		finally { if (current.current === scope) setPending(false); }
	};
	const blocked = disabled || pending, match = (text: string) => text.toLowerCase().includes(query.toLowerCase());
	return <section className="context-panel" aria-busy={pending}>
		<header className="context-heading"><h3><Icon name="context" />Opening context</h3>
			<button className="icon-action" type="button" aria-label="Refresh context" disabled={pending} onClick={() => void refresh()}><Icon name="refresh" /></button></header>
		<p className="muted">Conversation choices apply to future requests. Removing an advertisement does not erase content already read into history.</p>
		{error && <p className="error-text" role="alert">{error}</p>}
		{!data ? <p className="muted">{pending ? "Reading native Pi context…" : "Context could not be loaded."}</p> : <>
			<div className="context-summary"><span>≈ {data.estimatedTokens.toLocaleString()} tokens</span><span>{data.instructions.filter(item => item.included).length} instruction files</span>
				<span>{data.skills.filter(item => item.included).length} skills</span><span>{data.tools.filter(item => item.declared).length} declared tools</span></div>
			{!file && <div className="context-tabs" role="tablist" aria-label="Context resources">{["instructions", "skills", "tools", "prompt"].map(id =>
				<button type="button" key={id} id={`context-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="context-resources"
					onClick={() => { setTab(id); setQuery(""); }}>{id === "prompt" ? "Full prompt" : id[0]!.toUpperCase() + id.slice(1)}</button>)}</div>}
			{file ? <div className="context-editor">
				<h4>{file.editable ? "Edit" : "View"} {name(file.path)}</h4><p className="context-path">{file.path}</p>
				<p className="muted">Saving changes this file on its computer, not just this conversation. Other sessions read the new file when their resources reload.</p>
				<textarea aria-label="Instruction file content" spellCheck={false} readOnly={!file.editable} value={draft} onChange={event => setDraft(event.target.value)} />
				<div className="context-editor-actions">{file.editable && <button type="button" disabled={blocked || draft === file.text} onClick={() => void save()}><Icon name="check" />Save file</button>}
					<button type="button" disabled={pending} onClick={() => setFile(undefined)}>{file.editable ? "Cancel" : "Close file"}</button></div>
			</div> : <div id="context-resources" role="tabpanel" aria-labelledby={`context-tab-${tab}`}>
				{tab !== "prompt" && <input className="context-search" type="search" value={query} aria-label={`Find ${tab}`} placeholder={`Find ${tab}…`} onChange={event => setQuery(event.target.value)} />}
				{tab === "instructions" && <div className="context-list">{data.instructions.filter(item => match(item.path)).map(item => <div className="context-row" key={item.id}>
					<label><input type="checkbox" checked={item.included} disabled={blocked} onChange={event => void change({ resource: "instruction", id: item.id, included: event.target.checked })} />
						<span><strong>{name(item.path)}</strong><small>{item.path}</small><small>{item.characters.toLocaleString()} characters</small></span></label>
					<button className="quiet-action" type="button" disabled={pending} onClick={() => void edit(item.path)}><Icon name={item.editable ? "edit" : "file"} />{item.editable ? "Edit file" : "View file"}</button>
				</div>)}</div>}
				{tab === "skills" && <div className="context-list">{data.skills.filter(item => match(`${item.id} ${item.description}`)).map(item => <div className="context-row" key={item.id}>
					<label><input type="checkbox" checked={item.included} disabled={blocked} onChange={event => void change({ resource: "skill", id: item.id, included: event.target.checked })} />
						<span><strong>{item.id}</strong><small>{item.description}</small><small>{item.path}</small></span></label>
				</div>)}</div>}
				{tab === "tools" && <><p className="muted">Selected tools use Pi’s native loadout. Codemode and deferred catalogs can remain callable without a direct declaration; these choices are not access permissions.</p>
					<div className="context-list">{data.tools.filter(item => match(`${item.id} ${item.description}`)).map(item => <div className="context-row" key={item.id}>
						<label>{item.selectable ? <input type="checkbox" checked={item.selected} disabled={blocked} onChange={event => void change({ resource: "tool", id: item.id, included: event.target.checked })} /> : <Icon name="code" />}
							<span><strong>{item.id}</strong><small>{item.description}</small><small>{item.exposure} · {item.declared ? "Declared" : "Not declared"}{item.callable ? " · Callable" : ""}</small></span></label>
					</div>)}</div></>}
				{tab === "prompt" && <><p className="muted">Effective native system prompt. Token size is estimated at four characters per token, including current direct tool schemas.</p>
					<textarea className="context-prompt" readOnly aria-label="Effective system prompt" value={data.prompt} spellCheck={false} /></>}
			</div>}
		</>}
	</section>;
}
