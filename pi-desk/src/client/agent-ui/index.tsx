import { Component, createContext, lazy, Suspense, useContext, useMemo, type ReactNode } from "react";
import { createStateStore } from "@json-render/core";
import { JSONUIProvider, Renderer, type ComponentRegistry, type ComponentRenderProps } from "@json-render/react";
import { validateJson, validateSpec, type AgentSpec } from "../../../../pi-ui/agent-ui.ts";
import { catalogValidator, safeUiUrl, workCatalog, type CatalogDefinition } from "../../../../pi-ui/agent-catalog.ts";
import "./style.css";
export { workCatalog, catalogValidator } from "../../../../pi-ui/agent-catalog.ts";
export type { AgentSpec, AgentElement, AgentPatch } from "../../../../pi-ui/agent-ui.ts";
export type { ComponentRegistry, ComponentRenderProps } from "@json-render/react";
const Chart = lazy(() => import("./chart.tsx"));
const text = (value: unknown) => value == null ? "" : typeof value === "object" ? "" : String(value);
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const props = (value: ComponentRenderProps) => value.element.props as Record<string, unknown>;

/** The containing surface resolves attachment indices; specs never receive arbitrary file URLs. */
export const AgentFilesContext = createContext<((index: number, imageOnly: boolean, alt?: string) => ReactNode) | undefined>(undefined);
function Attachment(value: ComponentRenderProps) {
	const resolve = useContext(AgentFilesContext), p = props(value);
	return resolve?.(Number(p.item), value.element.type === "Image", text(p.alt)) ?? <p>Attachment unavailable.</p>;
}
export const workComponents: ComponentRegistry = {
	Column: ({ children }) => <div className="agent-column">{children}</div>,
	Row: ({ children }) => <div className="agent-ui-row">{children}</div>,
	Part: value => <details className="agent-part" open={props(value).collapsed !== true}><summary>{text(props(value).title)}</summary>{value.children}</details>,
	Text: value => <p className="agent-text">{text(props(value).text)}</p>,
	Metric: value => <div className="agent-metric"><span>{text(props(value).label)}</span><strong>{text(props(value).value)}</strong>{props(value).detail != null && <small>{text(props(value).detail)}</small>}</div>,
	Progress: value => {
		const p = props(value), done = number(p.done), total = number(p.total), ready = done !== undefined && total !== undefined && total > 0;
		return <div className="agent-progress"><div><strong>{text(p.label) || "Progress"}</strong><span>{done ?? "—"} / {total ?? "—"}</span></div>
			<progress aria-label={text(p.label) || "Progress"} value={ready ? Math.min(done, total) : undefined} max={total || 1} />
			<div className="agent-progress-detail"><span title={text(p.item)}>{text(p.item)}</span><span>{number(p.rate) !== undefined && `${p.rate}/s`}{number(p.eta) !== undefined && ` · ${Math.ceil(Number(p.eta))}s left`}{ready && p.rate == null && p.eta == null && `${Math.round(100 * done / total)}%`}</span></div></div>;
	},
	Table: value => {
		const p = props(value), columns = Array.isArray(p.columns) ? p.columns.slice(0, 24) : [], rows = Array.isArray(p.rows) ? p.rows.slice(0, 500) : [];
		return <div className="agent-table"><table><thead><tr>{columns.map((column, i) => <th key={i}>{text(column)}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{(Array.isArray(row) ? row : []).slice(0, 24).map((cell, j) => <td key={j}>{text(cell)}</td>)}</tr>)}</tbody></table></div>;
	},
	List: value => <ul className="agent-list">{(Array.isArray(props(value).items) ? props(value).items as unknown[] : []).slice(0, 200).map((item, i) => <li key={i}>{text(item)}</li>)}</ul>,
	Link: value => <a href={safeUiUrl(props(value).url)} target="_blank" rel="noopener noreferrer">{text(props(value).label) || text(props(value).url)} ↗</a>,
	Image: Attachment, File: Attachment,
	Code: value => <pre className="agent-code"><code>{text(props(value).text)}</code></pre>,
	Diff: value => <div className="agent-diff"><pre><del>{text(props(value).before)}</del></pre><pre><ins>{text(props(value).after)}</ins></pre></div>,
	Chart: value => <Suspense fallback={<p className="muted">Loading chart…</p>}><Chart spec={props(value).spec} /></Suspense>,
};

/** Home contributes schemas and native json-render components without maintaining another renderer. */
export function composeAgentCatalog(definitions: Record<string, CatalogDefinition>, components: ComponentRegistry) {
	return { definitions: { ...workCatalog, ...definitions }, components: { ...workComponents, ...components },
		validateElement: catalogValidator({ ...workCatalog, ...definitions }) };
}
class Boundary extends Component<{ children: ReactNode; spec: AgentSpec }, { error: boolean }> {
	state = { error: false };
	static getDerivedStateFromError() { return { error: true }; }
	componentDidUpdate(previous: { spec: AgentSpec }) { if (previous.spec !== this.props.spec && this.state.error) this.setState({ error: false }); }
	render() { return this.state.error ? <p role="alert">This view could not be rendered. Ask the agent to update it.</p> : this.props.children; }
}
type SurfaceProps = { spec: AgentSpec; components?: ComponentRegistry; state?: Record<string, unknown> };
/** Work and Home share the renderer; malformed content fails within its own surface. */
export function AgentSurface(input: SurfaceProps) { return <Boundary spec={input.spec}><SurfaceContent {...input} /></Boundary>; }
/** Render identity is trusted metadata, injected only after the persisted spec has been validated. */
function SurfaceContent({ spec, components, state }: SurfaceProps) {
	const checked = useMemo(() => validateSpec(spec), [spec]);
	const renderSpec = useMemo(() => ({ ...checked, elements: Object.fromEntries(Object.entries(checked.elements).map(([id, element]) => [id, { ...element, props: { ...element.props, $id: id } }])) }), [checked]);
	const registry = useMemo(() => ({ ...workComponents, ...components }), [components]);
	const store = useMemo(() => { const value = state ?? checked.state ?? {}; validateJson(value); return createStateStore(value); }, [state, checked.state]);
	return <div className="agent-surface"><JSONUIProvider registry={registry} store={store}><Renderer spec={renderSpec} registry={registry} /></JSONUIProvider></div>;
}
