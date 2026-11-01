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
		{item.shape === "blob" ? <path className="home-shape" d={homeBlob(item)} strokeDasharray={item.outline === "dashed" ? "5 6" : undefined} />
			: item.shape === "pill" ? <rect className="home-shape" width={item.width} height={item.height} rx={item.height / 2} strokeDasharray={item.outline === "dashed" ? "5 6" : undefined} /> : null}
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
type Point = { x: number; y: number };
/** Labels draw their 28px icon 8px in from the left; connectors meet the icon, never the text beside it. */
const LABEL_ICON = { inset: 22, radius: 16 };
/**
 * Where a connector meets an item, and the direction it leaves in. A blob or pill is met on its outline facing the
 * other end; a label is met on its icon, from above, below or the left, so the line stays clear of its words.
 */
function anchor(item: HomeItem, toward: Point): { point: Point; out: Point } {
	if (item.shape === "label") {
		const center = { x: item.x + LABEL_ICON.inset, y: item.y + item.height / 2 }, dx = toward.x - center.x, dy = toward.y - center.y;
		const out = dx < 0 && Math.abs(dx) > Math.abs(dy) ? { x: -1, y: 0 } : { x: 0, y: dy < 0 ? -1 : 1 };
		return { point: { x: center.x + out.x * LABEL_ICON.radius, y: center.y + out.y * LABEL_ICON.radius }, out };
	}
	const rx = item.width / 2, ry = item.height / 2, center = { x: item.x + rx, y: item.y + ry };
	const angle = Math.atan2((toward.y - center.y) / ry, (toward.x - center.x) / rx);
	// Blob outlines sit inside their box, so meet them a little inside the ellipse that fills it.
	const inset = item.shape === "blob" ? 0.9 : 0.97, out = { x: Math.cos(angle), y: Math.sin(angle) };
	return { point: { x: center.x + out.x * rx * inset, y: center.y + out.y * ry * inset }, out };
}
const middle = (item: HomeItem): Point => item.shape === "label"
	? { x: item.x + LABEL_ICON.inset, y: item.y + item.height / 2 } : { x: item.x + item.width / 2, y: item.y + item.height / 2 };
function Connector({ element }: ComponentRenderProps) {
	const { items } = useCanvas();
	const a = items.find(item => item.id === element.props.from), b = items.find(item => item.id === element.props.to); if (!a || !b) return null;
	const start = anchor(a, middle(b)), end = anchor(b, middle(a));
	const reach = Math.max(24, Math.hypot(end.point.x - start.point.x, end.point.y - start.point.y) * 0.42);
	// bend shifts both handles sideways, for the agent to separate connectors that would run together.
	const bend = Number(element.props.bend) || 0, length = Math.hypot(end.point.x - start.point.x, end.point.y - start.point.y) || 1;
	const side = { x: -(end.point.y - start.point.y) / length * bend * 0.5, y: (end.point.x - start.point.x) / length * bend * 0.5 };
	const c1 = { x: start.point.x + start.out.x * reach + side.x, y: start.point.y + start.out.y * reach + side.y };
	const c2 = { x: end.point.x + end.out.x * reach + side.x, y: end.point.y + end.out.y * reach + side.y };
	const color = (a.shape === "label" ? b : a).color;
	return <g className="home-link" style={{ "--home-color": `var(--${color})` } as CSSProperties}>
		<path d={`M ${start.point.x} ${start.point.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.point.x} ${end.point.y}`} />
		<circle cx={start.point.x} cy={start.point.y} r="2.6" /><circle cx={end.point.x} cy={end.point.y} r="2.6" />
	</g>;
}
export const homeComponents: ComponentRegistry = composeAgentCatalog(homeCatalog, { Canvas, Blob: Shape, Pill: Shape, Label: Shape, Connector }).components;
