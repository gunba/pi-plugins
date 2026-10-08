import { useEffect, useRef, useState } from "react";
import type { UiAction, UiValue } from "../../../pi-ui/index.ts";
import { configCategories, type ConfigViewData, type ConfigSettingView } from "../../../pi-config/view.ts";
import type { ViewSnapshot } from "../shared/protocol.ts";
import { Icon } from "./icons.tsx";

const initial = (query: string) => {
	const category = ({ md: "context", skills: "skill", prompts: "prompt", extensions: "extension" } as Record<string, string>)[query] ?? query;
	return configCategories.some(item => item.id === category) ? { category, query: "" } : { category: "settings", query };
};
export function Configuration({ view, disabled, invoke }: {
	view: ViewSnapshot; disabled: boolean; invoke: (action: UiAction, value?: UiValue) => void;
}) {
	const data = view.data as ConfigViewData;
	const [selection, setSelection] = useState(() => initial(data.query)), [page, setPage] = useState(0);
	const requested = useRef(false), attempted = useRef<string | undefined>(undefined);
	const results = useRef<HTMLDivElement>(null), lastOffset = useRef(data.offset);
	const action = (id: string, value?: UiValue) => { const item = view.actions?.find(item => item.id === id); if (item) invoke(item, value); };
	useEffect(() => { setSelection(initial(data.query)); setPage(0); }, [data.query]);
	useEffect(() => {
		if (!data.loaded && !disabled && !requested.current) { requested.current = true; action("browse"); }
	}, [data.loaded, disabled]);
	const { category, query } = selection;
	const changing = category !== data.category || query !== data.filter || page * 40 !== data.offset && page * 40 < data.total;
	useEffect(() => {
		if (!data.loaded || data.selected || disabled || !changing) return;
		const key = JSON.stringify([category, query, page]);
		if (attempted.current === key) return;
		const timer = setTimeout(() => { attempted.current = key; action("list", { category, query, offset: page * 40 }); }, 200);
		return () => clearTimeout(timer);
	}, [data.loaded, data.selected, disabled, changing, category, query, page, data.category, data.filter, data.offset]);
	useEffect(() => {
		if (lastOffset.current !== data.offset && results.current) {
			const container = results.current.closest(".settings-content");
			if (container) container.scrollTop += results.current.getBoundingClientRect().top - container.getBoundingClientRect().top - 16;
		}
		lastOffset.current = data.offset;
	}, [data.offset]);
	const rows = [...data.documents.map(file => ({ file })), ...data.settings.map(field => ({ field }))];
	const offset = data.offset;
	return <div className="configuration-browser">
		<header className="configuration-heading"><div><h3>Pi settings & resources</h3><p className="muted">This conversation’s settings and files on its computer.</p></div>
			<button className="icon-button" title="Refresh settings and resource inventory" aria-label="Refresh settings and resource inventory" disabled={disabled} onClick={() => { attempted.current = undefined; action(data.selected ? "reopen" : "browse"); }}><Icon name="refresh" /></button></header>
		{view.working && <p className="muted" role="status">{view.working}…</p>}
		{view.actionError && <p className="error-text" role="alert">{view.actionError}</p>}
		{data.warnings?.map(warning => <p className="error-text" key={warning}>{warning}</p>)}
		{data.selected ? <>
			<div className="configuration-file-heading"><button className="quiet-action" disabled={disabled} onClick={() => action("files")}>← Back</button>
				{view.actions?.some(item => item.id === "edit") && <button disabled={disabled} onClick={() => action("edit")}><Icon name="edit" />{data.selected.file.exists ? "Edit file" : "Create file"}</button>}</div>
			<h4>{data.selected.file.title}</h4><p className="configuration-path">{data.selected.file.path}</p>
			<div className="configuration-tags"><span>{data.selected.file.scope}</span>{data.selected.file.loaded && <span className="resource-loaded">Loaded</span>}{data.selected.file.readonly && <span>Read-only</span>}</div>
			{data.selected.file.note && <p className="muted">{data.selected.file.note}</p>}
			{!!data.selected.protectedCount && <p className="muted">{data.selected.protectedCount} protected fields stay on the computer. Their placeholders must remain unchanged.</p>}
			<pre className="configuration-preview">{data.selected.preview || (data.selected.file.readonly && !data.selected.file.exists ? "No file preview is available for this native resource." : "Empty file")}</pre>
			{data.selected.truncated && <p className="muted">Preview shortened. Open the editor for the complete file.</p>}
			<p className="muted">This is the saved file. Reload Pi resources after editing; some settings need a new session. Installed runtime files are read-only.</p>
		</> : <>
			<nav className="configuration-tabs" aria-label="Pi resource categories">{configCategories.map(item => <button key={item.id} aria-pressed={category === item.id}
				onClick={() => { setSelection({ ...selection, category: item.id }); setPage(0); }}>{item.title}</button>)}</nav>
			<input className="configuration-search" type="search" maxLength={500} aria-label="Search settings and resources" placeholder="Search names, settings, descriptions or paths" value={query}
				onChange={event => { setSelection({ ...selection, query: event.target.value }); setPage(0); }} />
			{(category === "settings" || category === "all") && <p className="muted">Active values come from Pi’s merged settings. Saved global/project values and reference defaults are separate; defaults can depend on the model.</p>}
			{category === "skill" && <p className="muted">Loaded skills are available to the agent by name. Their full instructions are read when needed.</p>}
			{category !== "settings" && !data.nativeResources && <p className="muted">This worker reports commands and discovered files, not a complete native loaded-resource inventory.</p>}
			{!data.loaded ? <button disabled={disabled} onClick={() => action("browse")}>Load settings and resources</button> : <>
				{changing && <p className="muted" role="status">Updating results…</p>}
				<div className="configuration-results" ref={results} aria-busy={changing}>{rows.map(row => "file" in row ? <button className="configuration-file" key={row.file.id} disabled={disabled || changing} onClick={() => action("open", row.file.id)}>
					<Icon name={row.file.kind === "extension" ? "plug" : row.file.kind === "context" ? "context" : row.file.kind === "settings" || row.file.kind === "model" ? "sliders" : "code"} />
					<span><strong title={row.file.title}>{row.file.title}</strong><small className="configuration-path" title={row.file.path}>{row.file.path}</small><span className="configuration-tags"><span>{row.file.scope}</span>
						{row.file.loaded ? <span className="resource-loaded">Loaded</span> : !row.file.exists ? <span>Not created</span> : <span>On disk</span>}{row.file.readonly && <span>Read-only</span>}</span></span><span aria-hidden="true">›</span>
				</button> : <Setting key={row.field.key} field={row.field} disabled={disabled || changing} review={scope => action("review-setting", { key: row.field.key, scope })} />)}</div>
				{!rows.length && <p className="muted">No matching settings or resources.</p>}
				<footer className="configuration-pagination"><span>{data.total ? `${offset + 1}–${Math.min(offset + 40, data.total)} of ${data.total}` : "0 results"}</span>
					{data.total > 40 && <><button disabled={disabled || changing || !offset} onClick={() => setPage(Math.max(0, offset / 40 - 1))}>Previous</button><button disabled={disabled || changing || offset + 40 >= data.total} onClick={() => setPage(offset / 40 + 1)}>Next</button></>}</footer>
			</>}
		</>}
	</div>;
}
function Setting({ field, disabled, review }: { field: ConfigSettingView; disabled: boolean; review: (scope: string) => void }) {
	return <details className="configuration-setting"><summary><span><strong>{field.label}</strong><code>{field.key}</code></span><span className="configuration-current" title={field.value ?? "Uses Pi’s default"}>{field.value ?? "Default"}</span></summary>
		<div><p>{field.description}</p><p className="muted">{field.type}{field.choices?.length ? ` · ${field.choices.join(" / ")}` : ""}</p>
			<dl>{[["Active", field.value], ["Saved · global", field.global], ["Saved · project", field.project], ["Reference default", field.defaultValue]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd><pre>{value ?? "Not set"}</pre></dd></div>)}</dl>
			<div className="configuration-setting-actions"><button disabled={disabled} onClick={() => review("project")}>Review in project file</button><button disabled={disabled} onClick={() => review("global")}>Review in global file</button></div>
		</div>
	</details>;
}
