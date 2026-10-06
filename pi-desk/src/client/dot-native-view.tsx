import { useEffect, useRef, useState, type PointerEvent } from "react";
import { api } from "./connection.ts";
import { stageDotFiles, saveDotDownload } from "./dot-files.ts";
import type { DotSurfaceFrame, DotSurfaceInput, DotDownload } from "../shared/dot.ts";

const modifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
	(event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

export function DotNativeView({ initial, connection, computer, close }: { initial: DotSurfaceFrame; connection: string; computer?: string; close: () => void }) {
	const [frame, setFrame] = useState(initial), [error, setError] = useState(""), [busy, setBusy] = useState(false), [halted, setHalted] = useState(false), [zoom, setZoom] = useState(1);
	const [pan, setPan] = useState(false), [textEntry, setTextEntry] = useState(() => matchMedia("(pointer: coarse)").matches);
	const [text, setText] = useState(""), [typing, setTyping] = useState(false);
	const image = useRef<HTMLImageElement>(null), picker = useRef<HTMLInputElement>(null), viewport = useRef<HTMLDivElement>(null), controls = useRef<HTMLDivElement>(null), back = useRef<HTMLButtonElement>(null);
	const queue = useRef(Promise.resolve()), active = useRef(true), failed = useRef(false), autoFit = useRef(true), textJob = useRef(false), moveAt = useRef(0);
	const pointer = useRef<{ id: number; button: "left" | "right"; count: 1 | 2; x: number; y: number } | undefined>(undefined);
	const lastDown = useRef<{ time: number; button: string; count: number; x: number; y: number } | undefined>(undefined);
	const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
	const blocked = halted || !!frame.error || busy;
	const fit = () => {
		const node = viewport.current;
		if (node && node.clientWidth > 24 && node.clientHeight > 24) setZoom(Math.max(.2, Math.min(1, (node.clientWidth - 24) / frame.width, (node.clientHeight - 24) / frame.height)));
	};
	useEffect(() => {
		const node = viewport.current; if (!node) return;
		const resized = () => { if (autoFit.current) fit(); };
		const observer = new ResizeObserver(resized); observer.observe(node); resized();
		return () => observer.disconnect();
	}, [frame.width, frame.height]);
	useEffect(() => {
		active.current = true; let timer: ReturnType<typeof setTimeout>, sequence = initial.sequence;
		const refresh = async () => {
			try {
				if (!document.hidden) {
					const next = await api<DotSurfaceFrame>(`/dot/surface/${initial.id}?after=${sequence}`, undefined, computer);
					sequence = next.sequence;
					if (active.current) setFrame(previous => ({ ...next, image: next.error ? undefined : next.image ?? previous.image }));
				}
			} catch (error) { if (active.current) setError(error instanceof Error ? error.message : String(error)); }
			if (active.current) timer = setTimeout(refresh, 250);
		};
		void refresh();
		return () => { active.current = false; clearTimeout(timer); void api(`/dot/surface/${initial.id}/close`, {}, computer).catch(() => {}); };
	}, [initial.id, computer]);
	const send = (input: DotSurfaceInput): Promise<boolean> => {
		if (failed.current || frame.error || busy) return Promise.resolve(false);
		const work = queue.current.catch(() => {}).then(async () => {
			if (!active.current || failed.current) return false;
			try { await api(`/dot/surface/${initial.id}/inputs`, { id: crypto.randomUUID(), width: frame.width, height: frame.height, input }, computer); return true; }
			catch (error) {
				failed.current = true; pointer.current = undefined;
				if (active.current) { setHalted(true); setError(`${error instanceof Error ? error.message : String(error)} Controls stopped. Return to the conversation and reopen this view after reviewing the result.`); }
				return false;
			}
		});
		queue.current = work.then(() => {}); return work;
	};
	const typeText = async () => {
		if (!text || textJob.current || blocked) return;
		const value = text; textJob.current = true; setTyping(true);
		try { if (await send({ kind: "text", text: value }) && active.current) setText(previous => previous === value ? "" : previous); }
		finally { textJob.current = false; if (active.current) setTyping(false); }
	};
	const point = (event: { clientX: number; clientY: number }) => {
		const rect = image.current!.getBoundingClientRect();
		return { x: Math.min(frame.width - 1, Math.max(0, (event.clientX - rect.left) * frame.width / rect.width)),
			y: Math.min(frame.height - 1, Math.max(0, (event.clientY - rect.top) * frame.height / rect.height)) };
	};
	const releasePointer = () => {
		const held = pointer.current; pointer.current = undefined; drag.current = undefined;
		if (held) void send({ kind: "pointer", phase: "up", x: held.x, y: held.y, button: held.button, count: held.count, modifiers: 0 });
	};
	const down = (event: PointerEvent<HTMLDivElement>) => {
		if (blocked) return;
		if (pan) {
			if (event.pointerType === "mouse" && event.button === 0 && viewport.current) {
				event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = { x: event.clientX, y: event.clientY, left: viewport.current.scrollLeft, top: viewport.current.scrollTop };
			}
			return;
		}
		if (pointer.current || ![0, 2].includes(event.button)) return;
		event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
		const position = point(event), button = event.button === 2 ? "right" : "left", previous = lastDown.current, time = performance.now();
		const count = previous?.count === 1 && previous.button === button && time - previous.time < 400 && Math.hypot(position.x - previous.x, position.y - previous.y) < 5 ? 2 : 1;
		lastDown.current = { ...position, time, button, count }; pointer.current = { ...position, id: event.pointerId, button, count };
		void send({ kind: "pointer", phase: "down", ...position, button, count, modifiers: modifiers(event) });
	};
	useEffect(() => {
		const node = controls.current; if (!node) return;
		const wheel = (event: WheelEvent) => {
			if (pan || blocked) return;
			event.preventDefault(); event.stopPropagation();
			const scale = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? node.clientHeight : 1;
			void send({ kind: "wheel", ...point(event), deltaX: Math.max(-4000, Math.min(4000, event.deltaX * scale)), deltaY: Math.max(-4000, Math.min(4000, event.deltaY * scale)) });
		};
		node.addEventListener("wheel", wheel, { passive: false });
		return () => node.removeEventListener("wheel", wheel);
	}, [pan, blocked, !!frame.image]);
	const choose = async (files: File[]) => {
		setBusy(true); setError("");
		try { const staged = await stageDotFiles(files, frame.dot, connection, computer); await api(`/dot/surface/${frame.id}/files`, { files: staged.map(file => file.id) }, computer); }
		catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setBusy(false); }
	};
	const download = async (file: DotDownload) => {
		setBusy(true); setError("");
		try { await saveDotDownload(file, computer, frame.id); }
		catch (error) { setError(error instanceof Error ? error.message : String(error)); }
		finally { setBusy(false); }
	};
	return <section className="dot-native-view">
		<div className="dot-native-toolbar"><button ref={back} onClick={close}>← Conversation</button><span>ChatGPT · {frame.mode === "activity" ? "Activity & tasks" : frame.mode === "computer" ? "Computer" : frame.mode === "settings" ? "Dot profile" : "Native conversation"}</span>
			<button aria-label="Fit native view" onClick={() => { autoFit.current = true; fit(); }}>Fit</button>
			<button aria-label="Zoom out" onClick={() => { autoFit.current = false; setZoom(value => Math.max(.2, value - .2)); }}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" onClick={() => { autoFit.current = false; setZoom(value => Math.min(2, value + .2)); }}>+</button>
			<button aria-pressed={pan} disabled={blocked} onClick={() => { releasePointer(); setPan(value => !value); }}>Pan</button>
			<button aria-pressed={textEntry} onClick={() => setTextEntry(value => !value)}>Type text</button>
		</div>
		{textEntry && <form className="dot-native-text" onSubmit={event => { event.preventDefault(); void typeText(); }}>
			<label htmlFor={`native-text-${initial.id}`}>Select a field in the view, then type here.</label>
			<textarea id={`native-text-${initial.id}`} aria-label="Text for native view" value={text} rows={2} maxLength={32_000} disabled={halted || !!frame.error || typing} onChange={event => setText(event.target.value)} />
			<div><button type="submit" disabled={blocked || typing || !text}>Insert text</button>
				{["Tab", "Enter", "Escape", "Backspace"].map(key => <button type="button" key={key} disabled={blocked || typing} onClick={() => void send({ kind: "key", key, code: key, modifiers: 0 })}>{key === "Escape" ? "Esc" : key}</button>)}
			</div>
		</form>}
		<p className="dot-native-help">{pan ? "Drag or scroll to move around the view. Turn off Pan to interact." : "Click to interact. Shift+Esc leaves the controls; Type text supports touch keyboards."}</p>
		{(error || frame.error) && <div role="alert" className="connection-banner">{error || frame.error}</div>}
		{frame.fileChooser && <div className="dot-native-file-prompt"><span>{busy ? "Preparing files…" : "Native file picker"}</span><button disabled={busy} onClick={() => picker.current?.click()}>Choose files</button></div>}
		<input ref={picker} type="file" hidden multiple={frame.fileChooser?.multiple} accept={frame.fileChooser?.accept} onChange={event => {
			const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; if (files.length) void choose(files);
		}} />
		{frame.downloads?.map(file => <div className="dot-native-file-prompt" key={file.id}><span>{file.name}</span><button disabled={busy} onClick={() => void download(file)}>Download</button></div>)}
		<div className="dot-native-viewport" ref={viewport}>
			{frame.image ? <div ref={controls} className={`dot-native-input${pan ? " panning" : ""}`} role={pan ? "img" : "application"} aria-label="Native Dot controls" aria-disabled={blocked} tabIndex={halted || pan ? -1 : 0} style={{ width: frame.width * zoom, height: frame.height * zoom }}
				onContextMenu={event => event.preventDefault()} onPointerDown={down}
				onPointerMove={event => {
					if (drag.current && viewport.current) { viewport.current.scrollLeft = drag.current.left - event.clientX + drag.current.x; viewport.current.scrollTop = drag.current.top - event.clientY + drag.current.y; return; }
					const held = pointer.current; if (!held || event.pointerId !== held.id || Date.now() - moveAt.current < 50) return;
					moveAt.current = Date.now(); const position = point(event); pointer.current = { ...held, ...position };
					void send({ kind: "pointer", phase: "move", ...position, button: held.button, count: held.count, modifiers: modifiers(event) });
				}} onPointerUp={event => {
					drag.current = undefined; const held = pointer.current; if (!held || event.pointerId !== held.id) return;
					pointer.current = undefined; void send({ kind: "pointer", phase: "up", ...point(event), button: held.button, count: held.count, modifiers: modifiers(event) });
				}} onPointerCancel={releasePointer} onLostPointerCapture={releasePointer} onBlur={releasePointer}
				onKeyDown={event => {
					if (event.key === "Escape" && event.shiftKey) { event.preventDefault(); event.stopPropagation(); releasePointer(); back.current?.focus(); return; }
					if (pan || blocked) return;
					if (event.nativeEvent.isComposing || event.key === "Process" || ["Shift", "Control", "Meta", "Alt"].includes(event.key)) return;
					if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
					event.preventDefault(); event.stopPropagation();
					void send({ kind: "key", key: event.key, code: event.code, modifiers: modifiers(event) });
				}} onPaste={event => { if (pan || blocked) return; event.preventDefault(); void send({ kind: "text", text: event.clipboardData.getData("text/plain") }); }}
				onCompositionEnd={event => { if (event.data && !pan && !blocked) void send({ kind: "text", text: event.data }); }}>
				<img ref={image} src={`data:image/jpeg;base64,${frame.image}`} alt="Native Dot interface" draggable={false} />
			</div> : <div className="dot-empty">{frame.error ? "Return to the conversation and reopen the native view." : "Opening the native view…"}</div>}
		</div>
	</section>;
}
