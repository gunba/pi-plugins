import { useEffect, useRef, useState } from "react";
import { homeItems, type HomeItem, type HomeScene } from "../shared/home.ts";
import { Icon } from "./icons.tsx";
import { AgentSurface } from "./agent-ui/index.tsx";
import { HomeCanvasContext, homeComponents } from "./home-components.tsx";

const GAP = 18;
/**
 * Pushes overlapping items apart for display, along whichever axis needs the smaller move, so a layout the agent
 * crowds still reads cleanly. The item Jordan is dragging stays under his pointer. The scene itself is not changed.
 */
function separate(items: HomeItem[], held?: string): HomeItem[] {
	const placed = items.map(item => ({ ...item }));
	for (let pass = 0; pass < 24; pass++) {
		let moved = false;
		for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
			const a = placed[i]!, b = placed[j]!;
			const overlapX = Math.min(a.x + a.width, b.x + b.width) + GAP - Math.max(a.x, b.x);
			const overlapY = Math.min(a.y + a.height, b.y + b.height) + GAP - Math.max(a.y, b.y);
			if (overlapX <= 0 || overlapY <= 0) continue;
			moved = true;
			const horizontal = overlapX < overlapY, amount = horizontal ? overlapX : overlapY;
			const direction = horizontal ? Math.sign(b.x + b.width / 2 - a.x - a.width / 2) || 1 : Math.sign(b.y + b.height / 2 - a.y - a.height / 2) || 1;
			const shareA = a.id === held ? 0 : b.id === held ? 1 : 0.5, axis = horizontal ? "x" : "y";
			a[axis] -= direction * amount * shareA; b[axis] += direction * amount * (1 - shareA);
		}
		if (!moved) break;
	}
	return placed;
}

export function HomeCanvas({ scene, state, open, move }: { scene: HomeScene; state?: Record<string, unknown>; open: (item: HomeItem) => void; move: (id: string, x: number, y: number) => void }) {
	const element = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [camera, setCamera] = useState({ x: 30, y: 20, zoom: 1 });
	const cameraRef = useRef(camera); cameraRef.current = camera;
	const [dragged, setDragged] = useState<{ id: string; x: number; y: number }>();
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const gesture = useRef<{ camera: typeof camera; x: number; y: number; distance: number; item?: HomeItem; moved: boolean } | undefined>(undefined);
	const initialized = useRef(false), suppressClick = useRef(false);
	const sourceItems = homeItems(scene);
	const items = separate(sourceItems.map(item => dragged?.id === item.id ? { ...item, x: dragged.x, y: dragged.y } : item), dragged?.id);
	const fit = () => {
		if (!sourceItems.length) return;
		const left = Math.min(...sourceItems.map(item => item.x)) - 35, top = Math.min(...sourceItems.map(item => item.y)) - 35;
		const right = Math.max(...sourceItems.map(item => item.x + item.width)) + 35, bottom = Math.max(...sourceItems.map(item => item.y + item.height)) + 35;
		const zoom = Math.max(0.15, Math.min(1.25, size.width / (right - left), size.height / (bottom - top)));
		setCamera({ x: (size.width - (right - left) * zoom) / 2 - left * zoom, y: (size.height - (bottom - top) * zoom) / 2 - top * zoom, zoom });
	};
	useEffect(() => {
		const node = element.current!;
		const observer = new ResizeObserver(([entry]) => { if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
		observer.observe(node); return () => observer.disconnect();
	}, []);
	useEffect(() => {
		if (initialized.current || !sourceItems.length || !size.width) return;
		initialized.current = true;
		if (size.width > 600) fit();
		else { const first = sourceItems[0]!; setCamera({ x: 20 - first.x * 0.85, y: 35 - first.y * 0.85, zoom: 0.85 }); }
	}, [sourceItems.length, size]);
	const zoomAt = (factor: number, x = size.width / 2, y = size.height / 2) => setCamera(current => {
		const zoom = Math.max(0.15, Math.min(2.5, current.zoom * factor)), ratio = zoom / current.zoom;
		return { x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio, zoom };
	});
	useEffect(() => {
		const node = element.current!;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			if (event.ctrlKey || event.metaKey) { const box = node.getBoundingClientRect(); zoomAt(Math.exp(-event.deltaY * 0.008), event.clientX - box.left, event.clientY - box.top); }
			else setCamera(current => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
		};
		node.addEventListener("wheel", wheel, { passive: false }); return () => node.removeEventListener("wheel", wheel);
	}, [size]);
	const point = (event: { clientX: number; clientY: number }) => { const box = element.current!.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
	const start = (item?: HomeItem) => {
		const values = [...pointers.current.values()], a = values[0]!, b = values[1];
		gesture.current = { camera: cameraRef.current, x: b ? (a.x + b.x) / 2 : a.x, y: b ? (a.y + b.y) / 2 : a.y,
			distance: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0, item: b ? undefined : item, moved: false };
	};
	return <HomeCanvasContext.Provider value={{ camera, items, open, move, suppressClick }}><div className={`home-canvas${dragged ? " dragging" : ""}`} ref={element} aria-label="Home canvas"
		onPointerDown={event => {
			if (event.button !== 0 || (event.target as Element).closest(".home-zoom")) return;
			pointers.current.set(event.pointerId, point(event)); event.currentTarget.setPointerCapture(event.pointerId);
			const id = (event.target as Element).closest("[data-home-item]")?.getAttribute("data-home-item");
			if (pointers.current.size > 1) { setDragged(undefined); suppressClick.current = true; }
			else suppressClick.current = false;
			start(items.find(item => item.id === id));
		}}
		onPointerMove={event => {
			if (!pointers.current.has(event.pointerId) || !gesture.current) return;
			pointers.current.set(event.pointerId, point(event));
			const values = [...pointers.current.values()], a = values[0]!, b = values[1], g = gesture.current;
			const x = b ? (a.x + b.x) / 2 : a.x, y = b ? (a.y + b.y) / 2 : a.y, dx = x - g.x, dy = y - g.y;
			if (Math.hypot(dx, dy) > 4 || b) { g.moved = true; suppressClick.current = true; }
			if (!g.moved) return;
			if (g.item && !b) setDragged({ id: g.item.id, x: Math.max(-4000, Math.min(4000, g.item.x + dx / g.camera.zoom)), y: Math.max(-4000, Math.min(4000, g.item.y + dy / g.camera.zoom)) });
			else {
				const zoom = b && g.distance ? Math.max(0.15, Math.min(2.5, g.camera.zoom * Math.hypot(a.x - b.x, a.y - b.y) / g.distance)) : g.camera.zoom;
				setCamera({ x: x - (g.x - g.camera.x) * zoom / g.camera.zoom, y: y - (g.y - g.camera.y) * zoom / g.camera.zoom, zoom });
			}
		}}
		onPointerUp={event => {
			if (!pointers.current.has(event.pointerId)) return;
			pointers.current.delete(event.pointerId);
			const g = gesture.current;
			if (g?.item && !g.moved && !suppressClick.current) { open(g.item); suppressClick.current = true; }
			if (dragged && gesture.current?.item) { move(dragged.id, dragged.x, dragged.y); setDragged(undefined); }
			if (pointers.current.size) start(); else gesture.current = undefined;
		}}
		onPointerCancel={event => { pointers.current.delete(event.pointerId); setDragged(undefined); gesture.current = undefined; suppressClick.current = true; }}>
		<AgentSurface spec={scene.spec} components={homeComponents} state={state} />
		{!items.length && <div className="home-empty"><Icon name="layers" /><h2>A place for everything on your mind.</h2><p>Tell Desk what you need. Home will arrange it here.</p></div>}
		<div className="home-zoom"><button className="icon-button" aria-label="Zoom out" onClick={() => zoomAt(0.8)}>−</button><button className="text-button" onClick={fit} title="Fit canvas">{Math.round(camera.zoom * 100)}%</button><button className="icon-button" aria-label="Zoom in" onClick={() => zoomAt(1.25)}>+</button></div>
	</div></HomeCanvasContext.Provider>;
}
