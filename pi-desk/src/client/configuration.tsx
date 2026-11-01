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
		if (lastOffset.current !== data.offset && results.current) results.current.scrollTop = 0;
		lastOffset.current = data.offset;
	}, [data.offset]);
	const rows = [...data.documents.map(file => ({ file })), ...data.settings.map(field => ({ field }))];
	const offset = data.offset;
	// A setting opens beside the list from the page already loaded; a file is opened by the worker, which keeps the list.
	const [settingKey, setSettingKey] = useState<string>();
	const setting = data.selected ? undefined : data.settings.find(field => field.key === settingKey);
	const busy = disabled || changing;
	const fileIcon = (kind: string) => kind === "extension" ? "plug" : kind === "context" ? "context" : kind === "settings" || kind === "model" ? "sliders" : "code";
	return <div className="configuration-browser">
		<header className="configuration-toolbar">
			<nav className="configuration-tabs" aria-label="Pi resource categories">{configCategories.map(item => <button key={item.id} aria-pressed={category === item.id}
				onClick={() => { setSelection({ ...selection, category: item.id }); setPage(0); }}>{item.title}</button>)}</nav>
			<input className="configuration-search" type="search" maxLength={500} aria-label="Search settings and resources" placeholder="Search" value={query}
				onChange={event => { setSelection({ ...selection, query: event.target.value }); setPage(0); }} />
			<button className="icon-button" title="Refresh settings and resource inventory" aria-label="Refresh settings and resource inventory" disabled={disabled}
				onClick={() => { attempted.current = undefined; action(data.selected ? "reopen" : "browse"); }}><Icon name="refresh" /></button>
		</header>
		{view.working && <p className="muted" role="status">{view.working}…</p>}
		{view.actionError && <p className="error-text" role="alert">{view.actionError}</p>}
		{data.warnings?.map(warning => <p className="error-text" key={warning}>{warning}</p>)}
		{!data.loaded ? <button disabled={disabled} onClick={() => action("browse")}>Load settings and resources</button> : <div className="configuration-split">
			<div className="configuration-list">
				<div className="configuration-results" ref={results} aria-busy={changing}>{rows.map(row => "file" in row
					? <button className="configuration-row" key={row.file.id} disabled={busy} title={row.file.path}
						aria-current={data.selected?.file.id === row.file.id ? "true" : undefined}
						onClick={() => { setSettingKey(undefined); action("open", row.file.id); }}>
						<Icon name={fileIcon(row.file.kind)} /><strong>{row.file.title}</strong>
						<small>{row.file.scope}{row.file.loaded ? " · loaded" : !row.file.exists ? " · not created" : ""}{row.file.readonly ? " · read-only" : ""}</small>
					</button>
					: <button className="configuration-row" key={row.field.key} disabled={busy} title={row.field.key}
						aria-current={!data.selected && settingKey === row.field.key ? "true" : undefined}
						onClick={() => { setSettingKey(row.field.key); if (data.selected) action("files"); }}>
						<Icon name="sliders" /><strong>{row.field.label}</strong><code>{row.field.value ?? "default"}</code>
					</button>)}
					{!rows.length && <p className="muted">{changing ? "Updating results…" : "No matching settings or resources."}</p>}
				</div>
				{data.total > 40 && <footer className="configuration-pagination"><span>{`${offset + 1}–${Math.min(offset + 40, data.total)} of ${data.total}`}</span>
					<button disabled={busy || !offset} onClick={() => setPage(Math.max(0, offset / 40 - 1))}>Previous</button>
					<button disabled={busy || offset + 40 >= data.total} onClick={() => setPage(offset / 40 + 1)}>Next</button></footer>}
			</div>
			<section className="configuration-detail" aria-label="Selected setting or file">
				{data.selected ? <>
					<div className="configuration-detail-heading"><div><h4>{data.selected.file.title}</h4><p className="configuration-path">{data.selected.file.path}</p></div>
						{view.actions?.some(item => item.id === "edit") && <button disabled={disabled} onClick={() => action("edit")}><Icon name="edit" />{data.selected.file.exists ? "Edit" : "Create"}</button>}</div>
					<p className="muted">{data.selected.file.scope}{data.selected.file.loaded ? " · loaded" : ""}{data.selected.file.readonly ? " · read-only: installed with the runtime" : ""}
						{data.selected.file.note ? ` · ${data.selected.file.note}` : ""}{data.selected.protectedCount ? ` · ${data.selected.protectedCount} protected fields stay on the computer; keep their placeholders` : ""}</p>
					<pre className="configuration-preview">{data.selected.preview || (data.selected.file.readonly && !data.selected.file.exists ? "No file preview is available for this native resource." : "Empty file")}</pre>
					{data.selected.truncated && <p className="muted">Preview shortened. Edit to see the whole file.</p>}
				</> : setting ? <Setting field={setting} disabled={busy} review={scope => action("review-setting", { key: setting.key, scope })} />
				: <div className="configuration-hint muted">
					<p>Choose a setting or file to see it here.</p>
					{(category === "settings" || category === "all") && <p>Settings show the active value from Pi's merged settings; global and project files and the reference default are shown separately.</p>}
					{category === "skill" && <p>Loaded skills are available to the agent by name; their full instructions are read when needed.</p>}
					{category !== "settings" && !data.nativeResources && <p>This conversation reports commands and discovered files, not a complete loaded-resource inventory.</p>}
					<p>Reload Pi resources after editing; some settings need a new session.</p>
				</div>}
			</section>
		</div>}
	</div>;
}
function Setting({ field, disabled, review }: { field: ConfigSettingView; disabled: boolean; review: (scope: string) => void }) {
	return <div className="configuration-setting">
		<h4>{field.label}</h4><code>{field.key}</code>
		<p>{field.description}</p>
		<p className="muted">{field.type}{field.choices?.length ? ` · ${field.choices.join(" / ")}` : ""}</p>
		<dl>{[["Active", field.value], ["Default", field.defaultValue], ["Saved · global", field.global], ["Saved · project", field.project]].map(([name, value]) =>
			<div key={name}><dt>{name}</dt><dd><pre>{value ?? "Not set"}</pre></dd></div>)}</dl>
		<div className="configuration-setting-actions"><button disabled={disabled} onClick={() => review("global")}>Edit in global file</button>
			<button disabled={disabled} onClick={() => review("project")}>Edit in project file</button></div>
	</div>;
}
