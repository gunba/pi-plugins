import { useEffect, useRef } from "react";
import { homeUrl, homeWorkKey, type HomeWork } from "../shared/home.ts";

/**
 * Home's canvas: the SVG the agent wrote, shown as written and scaled to fit. It sits in a frame without scripts, so
 * anything it contains only draws; Desk handles its clicks. An element with data-open opens that live work, and a link
 * opens in a new tab.
 */
export function HomeCanvas({ svg, work, open }: { svg: string; work: HomeWork[]; open: (work: HomeWork) => void }) {
	const frame = useRef<HTMLIFrameElement>(null), current = useRef({ work, open });
	current.current = { work, open };
	useEffect(() => {
		const element = frame.current;
		if (!element) return;
		const attach = () => element.contentDocument?.addEventListener("click", event => {
			const target = (event.target as Element | null)?.closest?.("[data-open], a");
			if (!target) return;
			event.preventDefault();
			const key = target.getAttribute("data-open"), href = target.getAttribute("href") ?? target.getAttribute("xlink:href") ?? "";
			const found = key ? current.current.work.find(entry => homeWorkKey(entry) === key) : undefined;
			if (found) current.current.open(found);
			else if (homeUrl(href)) window.open(href, "_blank", "noopener,noreferrer");
		});
		element.addEventListener("load", attach);
		if (element.contentDocument?.readyState === "complete") attach();
		return () => element.removeEventListener("load", attach);
	}, []);
	const document = `<!doctype html><html><head><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}
body>svg{display:block;width:100%;height:100%}[data-open],a{cursor:pointer}</style></head><body>${svg}</body></html>`;
	return <div className="home-canvas">{svg
		? <iframe ref={frame} className="home-frame" title="Home" sandbox="allow-same-origin" srcDoc={document} />
		: <p className="home-empty muted">Home draws your tasks and live work here.</p>}</div>;
}
