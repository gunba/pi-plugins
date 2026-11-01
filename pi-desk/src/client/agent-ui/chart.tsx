import { useEffect, useRef, useState } from "react";
import { compile, type TopLevelSpec } from "vega-lite";
import { parse, View } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { validateChart } from "../../../../pi-ui/agent-catalog.ts";

export default function AgentChart({ spec }: { spec: unknown }) {
	const container = useRef<HTMLDivElement>(null), [error, setError] = useState("");
	useEffect(() => {
		let view: View | undefined, disposed = false;
		const draw = () => {
			try {
				validateChart(spec);
				view?.finalize();
				const css = getComputedStyle(document.documentElement), color = (name: string) => css.getPropertyValue(name).trim();
				const chart = { ...(spec as object), width: Math.max(120, (container.current?.clientWidth ?? 320) - 10), height: 180,
					background: "transparent", config: { font: "system-ui", view: { stroke: null },
						axis: { labelColor: color("--muted"), titleColor: color("--muted"), gridColor: color("--border"), domainColor: color("--border") },
						legend: { labelColor: color("--text"), titleColor: color("--text") },
						range: { category: [color("--accent"), color("--muted"), color("--input-needed"), color("--danger")] }, mark: { color: color("--accent") } } };
				const runtime = parse(compile(chart as TopLevelSpec).spec, undefined, { ast: true });
				view = new View(runtime, { expr: expressionInterpreter, renderer: "svg", loader: {
					load: async () => { throw new Error("Chart network access is disabled."); },
					sanitize: async () => { throw new Error("Chart links are disabled."); },
					http: async () => { throw new Error("Chart network access is disabled."); },
					file: async () => { throw new Error("Chart file access is disabled."); },
				} }).initialize(container.current!);
				void view.runAsync().then(() => { if (!disposed) setError(""); }, () => { if (!disposed) setError("The chart could not be rendered."); });
			} catch (error) { if (!disposed) setError(error instanceof Error ? error.message : "Invalid chart."); }
		};
		draw();
		const resize = new ResizeObserver(draw); if (container.current) resize.observe(container.current);
		const theme = new MutationObserver(draw); theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => { disposed = true; resize.disconnect(); theme.disconnect(); view?.finalize(); };
	}, [spec]);
	return <><div className="agent-chart" ref={container} />{error && <p role="alert">{error}</p>}</>;
}
