import type React from "react";
import { createContext, useContext, type CSSProperties, type MutableRefObject } from "react";
import { composeAgentCatalog, type ComponentRegistry, type ComponentRenderProps } from "./agent-ui/index.tsx";
import { homeBlob, homeCatalog, homeConnector, type HomeItem } from "../shared/home.ts";
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
/** Desk's own colour tokens, or a hue Home adds; both follow the light and dark themes. */
export const homeColor = (token: unknown): string =>
	["accent", "input-needed", "muted", "danger", "text"].includes(String(token)) ? `var(--${token})` : `var(--home-${String(token)})`;
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
		style={{ transform: `translate(${item.x}px, ${item.y}px)`, "--home-color": homeColor(item.color) } as CSSProperties}>
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
function Connector({ element }: ComponentRenderProps) {
	const { items } = useCanvas();
	const a = items.find(item => item.id === element.props.from), b = items.find(item => item.id === element.props.to); if (!a || !b) return null;
	const link = homeConnector(a, b, Number(element.props.bend) || 0);
	return <g className="home-link" style={{ "--home-color": homeColor(link.color) } as CSSProperties}>
		<path d={link.d} />
		<circle cx={link.start.x} cy={link.start.y} r="2.6" /><circle cx={link.end.x} cy={link.end.y} r="2.6" />
	</g>;
}
type Props = Record<string, unknown>;
/**
 * Free drawing sits where the agent puts it. One with a ref is an item: it follows a drag, and Enter opens it like a
 * click; the canvas handles pointers for every item.
 */
function Free({ element, children }: { element: ComponentRenderProps["element"]; children: React.ReactNode }) {
	const { items, open } = useCanvas();
	const props = element.props as Props, id = String(props.$id), item = items.find(entry => entry.id === id);
	const x = item?.x ?? Number(props.x), y = item?.y ?? Number(props.y), rotate = Number(props.rotate ?? 0);
	return <g className={item ? "home-free home-free-item" : "home-free"} data-home-item={item ? id : undefined}
		transform={`translate(${x} ${y})${rotate ? ` rotate(${rotate})` : ""}`}
		style={{ color: homeColor(props.color), opacity: props.opacity === undefined ? undefined : Number(props.opacity) }}
		{...item ? { tabIndex: 0, role: "button", "aria-label": String(props.text ?? props.name ?? id),
			onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(item); } } } : {}}>
		{children}
	</g>;
}
/** Fill and outline shared by Shape and Path: the fill defaults to the colour for shapes and to none for paths. */
function paint(props: Props, fillByDefault: boolean) {
	const fill = props.fill ?? (fillByDefault ? props.color : "none"), width = Number(props.strokeWidth ?? 1.5);
	return { fill: fill === "none" ? "none" : homeColor(fill), fillOpacity: fill === "none" ? undefined : Number(props.tint ?? 0.14),
		stroke: width ? "currentColor" : "none", strokeWidth: width, strokeDasharray: props.dashed ? "6 6" : undefined,
		strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
}
function Text({ element }: ComponentRenderProps) {
	const props = element.props as Props, size = Number(props.size), align = (props.align ?? "start") as "start" | "middle" | "end";
	const style = { fontSize: size, fontWeight: Number(props.weight ?? 400), fontStyle: props.italic ? "italic" : undefined } as const;
	return <Free element={element}>{props.width
		? <foreignObject width={Number(props.width)} height={1} className="home-text-box">
			<div style={{ ...style, textAlign: align === "middle" ? "center" : align === "end" ? "right" : "left" }}>{String(props.text)}</div></foreignObject>
		: <text className="home-text" y={size} textAnchor={align} style={style}>{String(props.text)}</text>}</Free>;
}
function ShapeElement({ element }: ComponentRenderProps) {
	const props = element.props as Props, width = Number(props.width), height = Number(props.height);
	return <Free element={element}>{props.kind === "ellipse"
		? <ellipse cx={width / 2} cy={height / 2} rx={width / 2} ry={height / 2} {...paint(props, true)} />
		: <rect width={width} height={height} rx={Number(props.radius ?? 0)} {...paint(props, true)} />}</Free>;
}
function Path({ element }: ComponentRenderProps) {
	return <Free element={element}><path d={String(element.props.d)} {...paint(element.props as Props, false)} /></Free>;
}
function IconElement({ element }: ComponentRenderProps) {
	const size = Number(element.props.size);
	return <Free element={element}><foreignObject width={size} height={size} className="home-icon-box"><Icon name={element.props.name as never} /></foreignObject></Free>;
}
export const homeComponents: ComponentRegistry = composeAgentCatalog(homeCatalog, { Canvas, Blob: Shape, Pill: Shape, Label: Shape, Connector, Text, Shape: ShapeElement, Path, Icon: IconElement }).components;
