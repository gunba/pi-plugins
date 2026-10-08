import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { ChatMessage, HistoryPage } from "../shared/protocol.ts";
import { HISTORY_CHARACTERS, HISTORY_COUNT, type HistoryPosition } from "../shared/history.ts";
import { api } from "./connection.ts";
import { reportDeskError } from "./desk-status.ts";
import { mergeMessages, recentMessages, transcriptKey, type CachedMessage } from "./state.ts";
import { transcriptRows } from "./transcript-rows.ts";
import { DisclosureStates } from "./disclosure.tsx";
interface ReadingPosition {
	from?: string; anchor?: string; offset: number; follow: boolean; sizes?: Record<string, number>;
}
const readingPositions = new Map<string, ReadingPosition>();
function rememberPosition(key: string, position: ReadingPosition): void {
	readingPositions.delete(key); readingPositions.set(key, position);
	while (readingPositions.size > 16) readingPositions.delete(readingPositions.keys().next().value!);
}

/** One native history window and a measured viewport, shared by root and child conversations. */
export function TranscriptView({ session, source, generation, connected, epoch, messages, onLatest, renderMessage, empty, footer, latestRequest }: {
	session: string; source?: string; generation: string; connected: boolean; epoch: number;
	messages: CachedMessage[]; onLatest: (source: string | undefined, page: HistoryPage) => void;
	renderMessage: (message: ChatMessage, results: Record<string, ChatMessage>, thinking?: ChatMessage[], traceContinues?: boolean) => ReactNode; empty?: ReactNode; footer?: ReactNode; latestRequest?: number;
}) {
	const storageKey = transcriptKey(session, source);
	const saved = useRef<ReadingPosition | undefined>(readingPositions.get(storageKey));
	const [page, setPage] = useState<HistoryPage | undefined>(() => messages.length
		&& (saved.current?.follow !== false || messages.some(message => message.entryId === saved.current?.anchor))
		? { messages: recentMessages(messages, HISTORY_COUNT, HISTORY_CHARACTERS), generation,
			revision: Math.max(0, ...messages.map(message => message.revision)) } : undefined);
	const [live, setLive] = useState(saved.current?.follow !== false);
	const [atEnd, setAtEnd] = useState(saved.current?.follow !== false);
	const [positioned, setPositioned] = useState(!page && !connected);
	const [loading, setLoading] = useState(!page && connected);
	const [pinned, setPinned] = useState("");
	const request = useRef(0), scroller = useRef<HTMLDivElement>(null);
	const loadingRef = useRef(false);
	const userScroll = useRef(false), restoring = useRef(true), following = useRef(live);
	const navigation = useRef(0), lastScrollTop = useRef(0), scrollPointer = useRef(false);
	const touchY = useRef<number | undefined>(undefined);
	const target = useRef<ReadingPosition | "start" | "end" | undefined>(saved.current?.follow === false ? saved.current : "end");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const restoreFrame = useRef<number | undefined>(undefined);
	const capture = useRef<() => ReadingPosition | undefined>(() => undefined);
	const lastLatestRequest = useRef(latestRequest);
	const details = useRef(new Map<string, boolean[]>());
	const disclosures = useRef(new Map<string, boolean>());
	const mountedRows = useRef(new WeakSet<HTMLDivElement>());
	const nativeMessages = useMemo(() => live
		? recentMessages(mergeMessages(page?.messages ?? [], messages), HISTORY_COUNT, HISTORY_CHARACTERS)
		: page?.messages ?? [], [page, messages, live]);
	const rows = useMemo(() => transcriptRows(nativeMessages), [nativeMessages]);
	const visible = useMemo(() => rows.map(row => row.message), [rows]);
	const newest = messages.at(-1);
	const moreRecent = page?.after ?? (newest && nativeMessages.at(-1) && newest.order > nativeMessages.at(-1)!.order
		? nativeMessages.slice().reverse().find(message => message.entryId)?.entryId : undefined);
	const older = page?.before || live && messages.length > nativeMessages.length ? nativeMessages.find(message => message.entryId)?.entryId : undefined;
	const pinnedIndex = visible.findIndex(message => message.id === pinned);
	const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: visible.length + 1, getScrollElement: () => scroller.current,
		getItemKey: useCallback((index: number) => visible[index]?.id ?? "end", [visible]),
		estimateSize: index => saved.current?.sizes?.[visible[index]?.id ?? ""] ?? (index === visible.length ? 60 : 220),
		overscan: 3, paddingStart: source ? 8 : 28, anchorTo: live ? "end" : "start", followOnAppend: live,
		scrollEndThreshold: 80,
		rangeExtractor: useCallback((range: Range) => {
			const indices = defaultRangeExtractor(range);
			return pinnedIndex < 0 || indices.includes(pinnedIndex) ? indices : [...indices, pinnedIndex].sort((a, b) => a - b);
		}, [pinnedIndex]),
	});
	const persist = () => {
		clearTimeout(timer.current);
		const position = capture.current();
		if (position) { saved.current = position; rememberPosition(storageKey, position); }
	};
	capture.current = () => {
		if (!page || restoring.current || !scroller.current || !visible.length) return;
		const top = scroller.current.scrollTop;
		const row = virtualizer.getVirtualItemForOffset(top);
		const index = Math.min(row?.index ?? 0, visible.length - 1);
		return {
			from: visible.slice(Math.max(0, index - 10)).find(message => message.entryId)?.entryId,
			anchor: visible[index]?.entryId, offset: Math.max(0, top - (row?.start ?? 0)), follow: following.current && !moreRecent,
			sizes: Object.fromEntries(virtualizer.takeSnapshot().slice(-HISTORY_COUNT - 1).map(item => [String(item.key), item.size])),
		};
	};
	const load = async (position: HistoryPosition = {}, restore: ReadingPosition | "start" | "end" = "end") => {
		const id = ++request.current, startedNavigation = navigation.current;
		if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
		target.current = undefined;
		restoring.current = !positioned; userScroll.current = false;
		loadingRef.current = true;
		if (!visible.length) setPositioned(false);
		setLoading(true);
		const query = new URLSearchParams(position as Record<string, string>);
		if (source) query.set("source", source);
		try {
			const data = await api<HistoryPage>(`/sessions/${session}/history?${query}`);
			if (id !== request.current || data.generation !== generation) return;
			const moved = navigation.current !== startedNavigation;
			// A reconnect refresh must not undo navigation performed while it was in flight.
			if (moved && page?.generation === generation && !position.before && !position.after) return;
			if (moved) restore = capture.current() ?? restore;
			if ((position.before || position.after) && typeof restore === "object") {
				const combined = mergeMessages(nativeMessages, data.messages);
				const window = position.before
					? recentMessages([...combined].reverse(), HISTORY_COUNT * 2, HISTORY_CHARACTERS * 2).reverse()
					: recentMessages(combined, HISTORY_COUNT * 2, HISTORY_CHARACTERS * 2);
				const anchor = restore.anchor;
				if (moved && !window.some(message => message.entryId === anchor)) return;
				const hasBefore = position.before ? !!data.before : !!older || window.length < combined.length;
				const hasAfter = position.after ? !!data.after : !!moreRecent || window.length < combined.length;
				setPage({ ...data, messages: window,
					before: hasBefore ? window.find(message => message.entryId)?.entryId : undefined,
					after: hasAfter ? window.slice().reverse().find(message => message.entryId)?.entryId : undefined });
			} else setPage(data);
			target.current = restore; restoring.current = true;
			const latest = !position.before && !position.after && !position.from;
			following.current = latest; setLive(latest); setAtEnd(latest);
			setPinned("");
			if (!position.before && !position.after && !position.from) onLatest(source, data);
		} catch (error) {
			if (id !== request.current || navigation.current !== startedNavigation && page?.generation === generation) return;
			restoring.current = false;
			if (position.from && /position no longer exists/.test(String(error))) {
				saved.current = undefined; void load(); return;
			}
			reportDeskError(error);
		} finally { if (id === request.current) { loadingRef.current = false; setLoading(false); } }
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
			lastLatestRequest.current = latestRequest;
			if (live) { virtualizer.scrollToEnd(); setAtEnd(true); }
			else void load();
		}
	}, [latestRequest]);
	useLayoutEffect(() => {
		const position = target.current;
		if (!position || !page) return;
		if (position === "end") virtualizer.scrollToEnd();
		else if (position === "start") virtualizer.scrollToOffset(0);
		else {
			const index = Math.max(0, rows.findIndex(row => row.message.entryId === position.anchor || row.thinking?.some(message => message.entryId === position.anchor)));
			virtualizer.scrollToIndex(index, { align: "start" });
		}
		let lastOffset: number | undefined;
		const reveal = () => {
			if (target.current !== position) return;
			const viewport = scroller.current;
			if (!viewport) return;
			const maximum = Math.max(0, virtualizer.getTotalSize() - viewport.clientHeight);
			let offset = position === "end" ? maximum : 0;
			if (typeof position === "object") {
				const index = Math.max(0, rows.findIndex(row => row.message.entryId === position.anchor || row.thinking?.some(message => message.entryId === position.anchor)));
				const start = virtualizer.getOffsetForIndex(index, "start")?.[0] ?? 0;
				offset = Math.min(maximum, start + Math.min(position.offset, virtualizer.measurementsCache[index]?.size ?? position.offset));
			}
			if (lastOffset !== offset || Math.abs(viewport.scrollTop - offset) > 1) {
				lastOffset = offset; virtualizer.scrollToOffset(offset);
				restoreFrame.current = requestAnimationFrame(reveal); return;
			}
			target.current = undefined; restoring.current = false; setPositioned(true); persist();
		};
		restoreFrame.current = requestAnimationFrame(reveal);
		return () => { if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current); };
	}, [page, visible]);
	// The bounded tail replaces its oldest row as new messages arrive, so its
	// item count (and final spacer key) need not change for the virtualizer.
	useLayoutEffect(() => {
		if (!live || restoring.current) return;
		const frame = requestAnimationFrame(() => {
			if (following.current && !restoring.current) { virtualizer.scrollToEnd(); setAtEnd(true); }
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
				if (following.current && !restoring.current) { virtualizer.scrollToEnd(); setAtEnd(true); }
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
			if ((event.target as HTMLElement).hasAttribute("data-disclosure")) return;
			const row = (event.target as HTMLElement).closest<HTMLElement>("[data-chat-id]");
			const id = row?.dataset.chatId;
			if (!row || !id) return;
			details.current.delete(id);
			details.current.set(id, [...row.querySelectorAll<HTMLDetailsElement>("details:not([data-disclosure])")].map(node => node.open));
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
		if (!following.current) return;
		following.current = false;
		setPage(previous => ({ generation, revision: previous?.revision ?? 0, before: older, messages: nativeMessages }));
		setLive(false);
	};
	const navigate = (earlier: boolean | undefined, eventTarget: EventTarget | null) => {
		const viewport = scroller.current;
		if (!viewport || !positioned) return;
		for (let node = eventTarget instanceof HTMLElement ? eventTarget : null; node && node !== viewport; node = node.parentElement) {
			if (node.scrollHeight > node.clientHeight + 1 && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) return;
		}
		navigation.current++; userScroll.current = true;
		if (restoring.current) {
			if (restoreFrame.current !== undefined) cancelAnimationFrame(restoreFrame.current);
			target.current = undefined; restoring.current = false;
			virtualizer.scrollToOffset(viewport.scrollTop);
		}
		if (earlier) hold();
		if (loadingRef.current || !connected) return;
		const anchor = capture.current();
		if (!anchor) return;
		// At an edge (including a short page), another gesture need not emit a scroll event.
		if (earlier && viewport.scrollTop <= 1 && older) void load({ before: older }, anchor);
		else if (earlier === false && !following.current && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 1)
			void load(moreRecent ? { after: moreRecent } : {}, moreRecent ? anchor : "end");
	};
	return <DisclosureStates.Provider value={disclosures.current}><div className={`transcript-pane ${source ? "child-transcript" : "root-transcript"}`} aria-busy={!positioned}>
		{loading && !positioned && <div className="history-status" role="status">Loading messages…</div>}
		{(!live || !atEnd) && visible.length > 0 && <button className="jump-to-latest" aria-label="Jump to newest messages"
			disabled={loading || !connected} onClick={() => void load()}>↓ <span>Back to latest</span></button>}
		<div className={`transcript-scroll ${source ? "transcript-messages" : "transcript"}`} ref={scroller}
			tabIndex={0} aria-label={source ? "Child conversation" : "Conversation"}
			onWheel={event => { if (event.deltaY) navigate(event.deltaY < 0, event.target); }}
			onTouchStart={event => { touchY.current = event.touches[0]?.clientY; }}
			onTouchMove={event => {
				const y = event.touches[0]?.clientY, previous = touchY.current;
				touchY.current = y;
				if (y !== undefined && previous !== undefined && y !== previous) navigate(y > previous, event.target);
			}}
			onPointerDown={event => { scrollPointer.current = event.target === event.currentTarget; if (scrollPointer.current) navigate(undefined, event.target); }}
			onPointerMove={event => { if (!(event.buttons & 1)) scrollPointer.current = false; if (scrollPointer.current) navigate(undefined, event.target); }}
			onPointerUp={() => { scrollPointer.current = false; }} onPointerCancel={() => { scrollPointer.current = false; }}
			onKeyDown={event => {
				if (event.target !== event.currentTarget) return;
				if (event.key === "End" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (connected) void load(); }
				else if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key))
					navigate(["PageUp", "Home", "ArrowUp"].includes(event.key) || event.key === " " && event.shiftKey, event.target);
			}}
			onScroll={() => {
				const viewport = scroller.current!, previous = lastScrollTop.current;
				lastScrollTop.current = viewport.scrollTop;
				const manual = userScroll.current; userScroll.current = false;
				if (restoring.current) return;
				const end = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 80; setAtEnd(end);
				if (manual) {
					if (!end || viewport.scrollTop < previous) hold();
					if (!loadingRef.current && connected) {
						const anchor = capture.current();
						if (viewport.scrollTop < previous && viewport.scrollTop < 100 && older && anchor) void load({ before: older }, anchor);
						else if (viewport.scrollTop > previous && end && !following.current) void load(moreRecent ? { after: moreRecent } : {}, moreRecent && anchor ? anchor : "end");
					}
				}
				clearTimeout(timer.current); timer.current = setTimeout(persist, 200);
			}}>
			<div className={`virtual-window ${source ? "" : "conversation"}`} style={{ height: virtualizer.getTotalSize(), position: "relative", padding: 0, visibility: positioned ? "visible" : "hidden" }}>
				{virtualizer.getVirtualItems().map(row => {
					const message = visible[row.index];
					return <div className="virtual-row" key={row.key} data-index={row.index} data-chat-entry={message?.entryId} data-chat-id={message?.id}
						ref={element => {
							if (element && message && !mountedRows.current.has(element)) {
								mountedRows.current.add(element);
								const states = details.current.get(message.id);
								if (states) element.querySelectorAll<HTMLDetailsElement>("details:not([data-disclosure])").forEach((node, index) => {
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
						{message ? renderMessage(message, rows[row.index]!.results, rows[row.index]!.thinking, rows[row.index]!.traceContinues) : <>
							{!visible.length && !loading && (empty ?? <p className="muted">No messages yet.</p>)}
							{footer}<div style={{ height: 28 }} />
						</>}
					</div>;
				})}
			</div>
		</div>
	</div></DisclosureStates.Provider>;
}
