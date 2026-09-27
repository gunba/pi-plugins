import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { ChatMessage, HistoryPage } from "../shared/protocol.ts";
import { HISTORY_CHARACTERS, HISTORY_COUNT, type HistoryPosition } from "../shared/history.ts";
import { api } from "./connection.ts";
import { mergeMessages, recentMessages, transcriptKey, type CachedMessage } from "./state.ts";
import { readPosition, savePosition, type ReadingPosition } from "./reading-position.ts";

/** One native history window and a measured viewport, shared by root and child conversations. */
export function TranscriptView({ session, source, generation, connected, epoch, messages, onLatest, renderMessage, empty, footer, latestRequest }: {
	session: string; source?: string; generation: string; connected: boolean; epoch: number;
	messages: CachedMessage[]; onLatest: (source: string | undefined, page: HistoryPage) => void;
	renderMessage: (message: ChatMessage) => ReactNode; empty?: ReactNode; footer?: ReactNode; latestRequest?: number;
}) {
	const storageKey = transcriptKey(session, source);
	const saved = useRef(readPosition(storageKey));
	const [page, setPage] = useState<HistoryPage>();
	const [live, setLive] = useState(saved.current?.follow !== false);
	const [loading, setLoading] = useState(false), [error, setError] = useState("");
	const [pinned, setPinned] = useState("");
	const request = useRef(0), scroller = useRef<HTMLDivElement>(null);
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
		if (position) { saved.current = position; savePosition(storageKey, position); }
	};
	capture.current = () => {
		if (!page || restoring.current || !scroller.current || !visible.length) return;
		const top = scroller.current.scrollTop;
		const row = virtualizer.getVirtualItemForOffset(top);
		const index = Math.min(row?.index ?? 0, visible.length - 1);
		return {
			from: visible.find(message => message.entryId)?.entryId,
			anchor: visible[index]?.entryId, offset: Math.max(0, top - (row?.start ?? 0)), follow: live && !moreRecent,
			sizes: Object.fromEntries(virtualizer.takeSnapshot().slice(-HISTORY_COUNT - 1).map(item => [String(item.key), item.size])),
		};
	};
	const load = async (position: HistoryPosition = {}, restore: ReadingPosition | "start" | "end" = "end") => {
		const id = ++request.current;
		if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
		restoring.current = true; userScroll.current = false;
		setLoading(true); setError("");
		const query = new URLSearchParams(position as Record<string, string>);
		if (source) query.set("source", source);
		try {
			const data = await api<HistoryPage>(`/sessions/${session}/history?${query}`);
			if (id !== request.current || data.generation !== generation) return;
			target.current = restore;
			setPage(data); setLive(!position.before && !position.after && !position.from);
			setPinned("");
			if (!position.before && !position.after && !position.from) onLatest(source, data);
		} catch (error) {
			if (id !== request.current) return;
			restoring.current = false;
			if (position.from && /position no longer exists/.test(String(error))) {
				saved.current = undefined; void load(); return;
			}
			setError(String(error));
		} finally { if (id === request.current) setLoading(false); }
	};
	useEffect(() => {
		if (connected) {
			const position = capture.current() ?? saved.current;
			if (position?.follow === false && position.from) void load({ from: position.from }, position);
			else void load();
		}
		return () => { request.current++; };
	}, [session, source, generation, connected, epoch]);
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
		{(visible.length > 0 || loading || error) && <div className="transcript-controls">
			<button disabled={!older || loading || !connected} onClick={() => void load({ before: older }, "end")}>Older</button>
			<button disabled={!moreRecent || loading || !connected} onClick={() => void load({ after: moreRecent }, "start")}>Newer</button>
			<button disabled={loading || !connected} onClick={() => void load()}>Latest</button>
			<small className="muted">{loading ? "Loading…" : live ? "Live" : moreRecent ? "Reading · newer messages" : "Reading"}</small>
		</div>}
		{error && <p className="error-text" role="alert">{error}</p>}
		<div className={`transcript-scroll ${source ? "transcript-messages" : "transcript"}`} ref={scroller}
			tabIndex={0} aria-label={source ? "Child conversation" : "Conversation"}
			onWheel={() => { userScroll.current = true; }} onTouchStart={() => { userScroll.current = true; }}
			onPointerDown={() => { userScroll.current = true; }}
			onKeyDown={event => { if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key)) userScroll.current = true; }}
			onScroll={() => {
				if (restoring.current) return;
				if (userScroll.current && !virtualizer.isAtEnd(80)) hold();
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
							if (message && (event.target as HTMLElement).closest(".file-link,.artifact-link,summary")) { setPinned(message.id); hold(); }
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
