import { createContext, useContext, type CSSProperties, type MutableRefObject } from "react";
import { composeAgentCatalog, type ComponentRegistry, type ComponentRenderProps } from "./agent-ui/index.tsx";
import { homeBlob, homeCatalog, type HomeItem } from "../shared/home.ts";
import { Icon } from "./icons.tsx";

export const HomeCanvasContext = createContext<{
	camera: { x: number; y: number; zoom: number }; items: HomeItem[];
	open: (item: HomeItem) => void; move: (id: string, x: number, y: number) => void;
	suppressClick: MutableRefObject<boolean>;
} | undefined>(undefined);
const useCanvas = () => {
	const context = useContext(HomeCanvasContext);
	if (!context) throw Error("Home components need a Home canvas.");
	return context;
};
function Canvas({ children }: ComponentRenderProps) {
	const { camera } = useCanvas();
	return <svg width="100%" height="100%" role="group" aria-label="Tasks and live work"><g transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>{children}</g></svg>;
}
function Shape({ element }: ComponentRenderProps) {
	const { items, open, move, suppressClick } = useCanvas();
	const id = String(element.props.$id), geometry = items.find(item => item.id === id);
	if (!geometry) return null;
	const item = { ...element.props, ...geometry, title: element.props.title, subtitle: element.props.subtitle, status: element.props.status } as HomeItem;
	return <g className={`home-item home-${item.shape}`} data-home-item={id}
		style={{ transform: `translate(${item.x}px, ${item.y}px)`, "--home-color": `var(--${item.color})` } as CSSProperties}>
		{item.shape === "blob" ? <path className="home-shape" d={homeBlob(item)} strokeDasharray={item.outline === "dashed" ? "6 7" : undefined} />
			: item.shape === "pill" ? <rect className="home-shape" width={item.width} height={item.height} rx={item.height / 2} strokeDasharray={item.outline === "dashed" ? "6 7" : undefined} /> : null}
		<foreignObject width={item.width} height={item.height}>
			<button className="home-item-content" aria-label={`${item.title}. ${item.subtitle}. ${item.status}`} onClick={() => { if (!suppressClick.current) open(item); }}
				onKeyDown={event => {
					if (event.key === "Enter" || event.key === " ") suppressClick.current = false;
					const delta = event.shiftKey ? 50 : 10, dx = event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0, dy = event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0;
					if (dx || dy) { event.preventDefault(); move(item.id, Math.max(-4000, Math.min(4000, item.x + dx)), Math.max(-4000, Math.min(4000, item.y + dy))); }
				}}>
				<span className="home-item-icon"><Icon name={item.icon} /></span>
				<span className="home-item-words"><strong>{item.title}</strong>{item.subtitle && <span>{item.subtitle}</span>}{item.status && <small>{item.status}</small>}</span>
			</button>
		</foreignObject>
	</g>;
}
function Connector({ element }: ComponentRenderProps) {
	const { items } = useCanvas();
	const a = items.find(item => item.id === element.props.from), b = items.find(item => item.id === element.props.to); if (!a || !b) return null;
	const ax = a.x + a.width / 2, ay = a.y + a.height / 2, bx = b.x + b.width / 2, by = b.y + b.height / 2, bend = Number(element.props.bend);
	return <path className="home-link" d={`M ${ax} ${ay} C ${ax + bend} ${(ay + by) / 2}, ${bx - bend} ${(ay + by) / 2}, ${bx} ${by}`} />;
}
export const homeComponents: ComponentRegistry = composeAgentCatalog(homeCatalog, { Canvas, Blob: Shape, Pill: Shape, Label: Shape, Connector }).components;
