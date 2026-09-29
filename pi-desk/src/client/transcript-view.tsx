import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { ChatMessage, HistoryPage } from "../shared/protocol.ts";
import { HISTORY_CHARACTERS, HISTORY_COUNT, type HistoryPosition } from "../shared/history.ts";
import { api } from "./connection.ts";
import { mergeMessages, recentMessages, transcriptKey, type CachedMessage } from "./state.ts";
interface ReadingPosition {
	from?: string; anchor?: string; offset: number; follow: boolean; sizes?: Record<string, number>;
}

/** One native history window and a measured viewport, shared by root and child conversations. */
export function TranscriptView({ session, source, generation, connected, epoch, starting, messages, onLatest, renderMessage, empty, footer, latestRequest }: {
	session: string; source?: string; generation: string; connected: boolean; epoch: number;
	starting?: boolean;
	messages: CachedMessage[]; onLatest: (source: string | undefined, page: HistoryPage) => void;
	renderMessage: (message: ChatMessage) => ReactNode; empty?: ReactNode; footer?: ReactNode; latestRequest?: number;
}) {
	const storageKey = transcriptKey(session, source);
	// Returning to a conversation opens its tail. Preserve a reading position only
	// across reconnects while this particular view remains mounted.
	const saved = useRef<ReadingPosition | undefined>(undefined);
	const [page, setPage] = useState<HistoryPage>();
	const [live, setLive] = useState(true);
	const [atEnd, setAtEnd] = useState(true);
	const [loading, setLoading] = useState(false), [error, setError] = useState("");
	const [pinned, setPinned] = useState("");
	const request = useRef(0), scroller = useRef<HTMLDivElement>(null);
	const loadingRef = useRef(false);
	const userScroll = useRef(false), restoring = useRef(false);
	const target = useRef<ReadingPosition | "start" | "end" | undefined>(undefined);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const restoreFrame = useRef<number | undefined>(undefined);
	const capture = useRef<() => ReadingPosition | undefined>(() => undefined);
	const lastLatestRequest = useRef(latestRequest);
	const details = useRef(new Map<string, boolean[]>());
	const mountedRows = useRef(new WeakSet<HTMLDivElement>());
	const visible = useMemo(() => {
		if (live) return recentMessages(mergeMessages(page?.messages ?? [], messages), HISTORY_COUNT, HISTORY_CHARACTERS);
		return page?.messages ?? [];
	}, [page, messages, live]);
	const newest = messages.at(-1);
	const moreRecent = page?.after ?? (newest && visible.at(-1) && newest.order > visible.at(-1)!.order
		? visible.slice().reverse().find(message => message.entryId)?.entryId : undefined);
	const older = page?.before || live && messages.length > visible.length ? visible.find(message => message.entryId)?.entryId : undefined;
	const pinnedIndex = visible.findIndex(message => message.id === pinned);
	const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: visible.length + 1, getScrollElement: () => scroller.current,
		getItemKey: useCallback((index: number) => visible[index]?.id ?? "end", [visible]),
		estimateSize: index => saved.current?.sizes?.[visible[index]?.id ?? ""] ?? (index === visible.length ? 60 : 220),
		overscan: 3, paddingStart: source ? 8 : 28, anchorTo: "end", followOnAppend: live,
		scrollEndThreshold: 80,
		rangeExtractor: useCallback((range: Range) => {
			const indices = defaultRangeExtractor(range);
			return pinnedIndex < 0 || indices.includes(pinnedIndex) ? indices : [...indices, pinnedIndex].sort((a, b) => a - b);
		}, [pinnedIndex]),
	});
	const persist = () => {
		clearTimeout(timer.current);
		const position = capture.current();
		if (position) saved.current = position;
	};
	capture.current = () => {
		if (!page || restoring.current || !scroller.current || !visible.length) return;
		const top = scroller.current.scrollTop;
		const row = virtualizer.getVirtualItemForOffset(top);
		const index = Math.min(row?.index ?? 0, visible.length - 1);
		return {
			from: visible.slice(Math.max(0, index - 10)).find(message => message.entryId)?.entryId,
			anchor: visible[index]?.entryId, offset: Math.max(0, top - (row?.start ?? 0)), follow: live && !moreRecent,
			sizes: Object.fromEntries(virtualizer.takeSnapshot().slice(-HISTORY_COUNT - 1).map(item => [String(item.key), item.size])),
		};
	};
	const load = async (position: HistoryPosition = {}, restore: ReadingPosition | "start" | "end" = "end") => {
		const id = ++request.current;
		if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
		restoring.current = true; userScroll.current = false;
		loadingRef.current = true;
		setLoading(true); setError("");
		const query = new URLSearchParams(position as Record<string, string>);
		if (source) query.set("source", source);
		try {
			const data = await api<HistoryPage>(`/sessions/${session}/history?${query}`);
			if (id !== request.current || data.generation !== generation) return;
			target.current = restore;
			if ((position.before || position.after) && typeof restore === "object") {
				const combined = mergeMessages(visible, data.messages);
				const window = position.before
					? recentMessages([...combined].reverse(), HISTORY_COUNT * 2, HISTORY_CHARACTERS * 2).reverse()
					: recentMessages(combined, HISTORY_COUNT * 2, HISTORY_CHARACTERS * 2);
				const hasBefore = position.before ? !!data.before : !!older || window.length < combined.length;
				const hasAfter = position.after ? !!data.after : !!moreRecent || window.length < combined.length;
				setPage({ ...data, messages: window,
					before: hasBefore ? window.find(message => message.entryId)?.entryId : undefined,
					after: hasAfter ? window.slice().reverse().find(message => message.entryId)?.entryId : undefined });
			} else setPage(data);
			const latest = !position.before && !position.after && !position.from;
			setLive(latest); setAtEnd(latest);
			setPinned("");
			if (!position.before && !position.after && !position.from) onLatest(source, data);
		} catch (error) {
			if (id !== request.current) return;
			restoring.current = false;
			if (position.from && /position no longer exists/.test(String(error))) {
				saved.current = undefined; void load(); return;
			}
			setError(String(error));
		} finally { if (id === request.current) { loadingRef.current = false; setLoading(false); } }
	};
	useEffect(() => {
		if (connected) {
			const position = capture.current() ?? saved.current;
			if (position?.follow === false && position.from) void load({ from: position.from }, position);
			else void load();
		}
		return () => { request.current++; };
	}, [session, source, generation, connected, epoch, starting]);
	useEffect(() => {
		if (lastLatestRequest.current !== latestRequest && connected) {
			lastLatestRequest.current = latestRequest; void load();
		}
	}, [latestRequest]);
	useLayoutEffect(() => {
		const position = target.current;
		if (!position || !page) return;
		target.current = undefined;
		if (position === "end") virtualizer.scrollToEnd();
		else if (position === "start") virtualizer.scrollToOffset(0);
		else {
			const index = Math.max(0, visible.findIndex(message => message.entryId === position.anchor));
			virtualizer.scrollToIndex(index, { align: "start" });
		}
		restoreFrame.current = requestAnimationFrame(() => {
			if (typeof position === "object") {
				const index = Math.max(0, visible.findIndex(message => message.entryId === position.anchor));
				const offset = virtualizer.getOffsetForIndex(index, "start")?.[0] ?? 0;
				virtualizer.scrollToOffset(offset + Math.min(position.offset, virtualizer.measurementsCache[index]?.size ?? position.offset));
			}
			restoreFrame.current = requestAnimationFrame(() => { restoring.current = false; persist(); });
		});
	}, [page]);
	// The bounded tail replaces its oldest row as new messages arrive, so its
	// item count (and final spacer key) need not change for the virtualizer.
	useLayoutEffect(() => {
		if (!live || restoring.current) return;
		const frame = requestAnimationFrame(() => {
			if (!restoring.current) { virtualizer.scrollToEnd(); setAtEnd(true); }
		});
		return () => cancelAnimationFrame(frame);
	}, [visible, live]);
	// Opening a panel or moving queued messages changes the viewport, not the
	// history. Keep a live tail pinned without disturbing an older reading window.
	useLayoutEffect(() => {
		const viewport = scroller.current;
		if (!viewport || !live) return;
		let frame: number | undefined;
		const observer = new ResizeObserver(() => {
			if (frame !== undefined) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (!restoring.current) { virtualizer.scrollToEnd(); setAtEnd(true); }
			});
		});
		observer.observe(viewport);
		return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); };
	}, [live, storageKey]);
	// A reading window stays put while current output advances. Existing live rows still finish.
	useEffect(() => {
		if (live || !page) return;
		setPage(previous => {
			if (!previous) return previous;
			let changed = false;
			const values = previous.messages.map(old => {
				const update = messages.find(message => message.id === old.id || message.replaces === old.id);
				if (update && update.revision > old.revision) { changed = true; return update; }
				return old;
			});
			return changed ? { ...previous, messages: values } : previous;
		});
	}, [messages, live]);
	useLayoutEffect(() => {
		const onLeave = () => persist();
		const node = scroller.current;
		const onToggle = (event: Event) => {
			const row = (event.target as HTMLElement).closest<HTMLElement>("[data-chat-id]");
			const id = row?.dataset.chatId;
			if (!row || !id) return;
			details.current.delete(id);
			details.current.set(id, [...row.querySelectorAll("details")].map(node => node.open));
			while (details.current.size > 80) details.current.delete(details.current.keys().next().value!);
		};
		addEventListener("pagehide", onLeave);
		node?.addEventListener("toggle", onToggle, true);
		return () => {
			persist(); if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
			removeEventListener("pagehide", onLeave); node?.removeEventListener("toggle", onToggle, true);
		};
	}, [storageKey]);
	const hold = () => {
		if (!live) return;
		setPage(previous => ({ generation, revision: previous?.revision ?? 0, before: older, messages: visible }));
		setLive(false);
	};
	return <div className={`transcript-pane ${source ? "child-transcript" : "root-transcript"}`}>
		{loading && <div className="history-status" role="status">Loading messages…</div>}
		{(!live || !atEnd) && visible.length > 0 && <button className="jump-to-latest" aria-label="Jump to newest messages"
			disabled={loading || !connected} onClick={() => void load()}>↓ <span>Back to latest</span></button>}
		{error && <p className="error-text" role="alert">{error}</p>}
		<div className={`transcript-scroll ${source ? "transcript-messages" : "transcript"}`} ref={scroller}
			tabIndex={0} aria-label={source ? "Child conversation" : "Conversation"}
			onWheel={() => { userScroll.current = true; }} onTouchMove={() => { userScroll.current = true; }}
			onPointerDown={event => { if (event.target === event.currentTarget) userScroll.current = true; }}
			onKeyDown={event => {
				if (event.key === "End" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (connected) void load(); }
				else if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key)) userScroll.current = true;
			}}
			onScroll={() => {
				if (restoring.current) return;
				const viewport = scroller.current!;
				const end = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 80; setAtEnd(end);
				if (userScroll.current) {
					if (!end) hold();
					if (!loadingRef.current && connected) {
						const anchor = capture.current();
						if (scroller.current!.scrollTop < 100 && older && anchor) void load({ before: older }, anchor);
						else if (end && !live) void load(moreRecent ? { after: moreRecent } : {}, moreRecent && anchor ? anchor : "end");
					}
				}
				clearTimeout(timer.current); timer.current = setTimeout(persist, 200);
			}}>
			<div className={`virtual-window ${source ? "" : "conversation"}`} style={{ height: virtualizer.getTotalSize(), position: "relative", padding: 0 }}>
				{virtualizer.getVirtualItems().map(row => {
					const message = visible[row.index];
					return <div className="virtual-row" key={row.key} data-index={row.index} data-chat-entry={message?.entryId} data-chat-id={message?.id}
						ref={element => {
							if (element && message && !mountedRows.current.has(element)) {
								mountedRows.current.add(element);
								const states = details.current.get(message.id);
								if (states) element.querySelectorAll("details").forEach((node, index) => {
									if (states[index] !== undefined && node.open !== states[index]) node.open = states[index]!;
								});
							}
							virtualizer.measureElement(element);
						}}
						onFocusCapture={() => { if (message) setPinned(message.id); }}
						onClickCapture={event => {
							if (message && (event.target as HTMLElement).closest(".file-link,.artifact-link,summary")) {
								userScroll.current = false; setPinned(message.id);
							}
						}}
						style={{ position: "absolute", width: "100%", top: 0, left: 0, transform: `translateY(${row.start}px)` }}>
						{message ? renderMessage(message) : <>
							{!visible.length && !loading && (empty ?? <p className="muted">No messages yet.</p>)}
							{footer}<div style={{ height: 28 }} />
						</>}
					</div>;
				})}
			</div>
		</div>
	</div>;
}
