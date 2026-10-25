import { createContext, memo, useContext, useState } from "react";
import Markdown from "react-markdown";
import type { ChatBlock, ChatMessage, NestedCall } from "../shared/protocol.ts";
import { FileLink } from "./file-view.tsx";
import { ReferenceContext, useReferenceQuery } from "./reference-origin.tsx";
import { acquireAsset } from "./connection.ts";
import { AssetImage, AssetLink } from "./assets.tsx";
import { ArtifactLink } from "./artifact-view.tsx";
import { ShownSummary, WorkChip, diffStats, type WorkItem } from "./change-view.tsx";
import { CodeBlock, Elapsed, LiveOutput } from "./transcript-parts.tsx";
import { LedgerCard } from "./ledger-card.tsx";
import { Icon } from "./icons.tsx";
import { Disclosure } from "./disclosure.tsx";
import { planRoundNotice } from "./plan-round.ts";
import { readSkills } from "../shared/skill-activity.ts";
import { isActivityOnly, isEmptyText } from "./state.ts";
import { markdownPlugins, markdownFile, markdownUrl } from "./markdown-links.ts";
import { thinkingPreview, toolArgumentPreview } from "./tool-preview.ts";
import { splitDictationNote } from "../shared/dictation-note.ts";

/** A user message without Desk's dictation note, when it has one; the note becomes a badge. */
function withoutDictationNote(message: ChatMessage): ChatMessage | undefined {
	if (message.role !== "user") return;
	for (let index = message.blocks.length - 1; index >= 0; index--) {
		const block = message.blocks[index];
		if (block?.type !== "text") continue;
		const split = splitDictationNote(block.text);
		return split.dictated ? { ...message, blocks: message.blocks.map((item, at) => at === index ? { ...block, text: split.text } : item) } : undefined;
	}
}

const tokenFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
async function assetText(session: string, asset: string, origin: string): Promise<string> {
	const lease = acquireAsset(session, asset, origin);
	try { return await (await fetch(await lease.loaded)).text(); } finally { lease.release(); }
}
/** Copies the message's own Markdown source, fetching complete text when the view holds a preview. */
function CopyMarkdown({ message, sessionKey }: { message: ChatMessage; sessionKey: string }) {
	const origin = useReferenceQuery();
	const [status, setStatus] = useState("");
	const blocks = message.blocks.filter((block): block is TextBlock => block?.type === "text" && !!block.text.trim());
	if (!blocks.length || message.complete === false) return null;
	const copy = () => {
		const done = (label: string) => { setStatus(label); setTimeout(() => setStatus(""), 1500); };
		const complete = () => Promise.all(blocks.map(block => block.full ? assetText(sessionKey, block.full, origin) : block.text))
			.then(parts => parts.join("\n\n"));
		// Browsers require the write to start within the click; a promised item keeps that while complete text loads.
		const write = !blocks.some(block => block.full) ? navigator.clipboard.writeText(blocks.map(block => block.text).join("\n\n"))
			: typeof ClipboardItem === "function" ? navigator.clipboard.write([new ClipboardItem({ "text/plain": complete().then(text => new Blob([text], { type: "text/plain" })) })])
			: complete().then(text => navigator.clipboard.writeText(text));
		void write.then(() => done(blocks.some(block => block.truncated && !block.full) ? "Copied preview" : "Copied"), () => done("Copy failed"));
	};
	return <button type="button" className="message-copy" title="Copy as Markdown" aria-label="Copy as Markdown" onClick={copy}>
		{status ? <span>{status}</span> : <Icon name="copy" />}</button>;
}
/** Rewinds the conversation to a message; unavailable (undefined) while Pi is working. */
export const RewindContext = createContext<{ rewind?: (message: ChatMessage) => void }>({});
/** The latest reply in the open conversation, which offers "What do I need to know?". */
/** review: asks the agent to review the turn's changes with the code-review skill, when the turn changed files. */
export const BriefContext = createContext<{ reply?: string; open?: () => void; state?: "writing" | "ready"; review?: () => void }>({});
function LatestBrief({ id }: { id: string }) {
	// Only conversations whose Desk version writes briefs offer one.
	const { reply, open, review } = useContext(BriefContext);
	return reply === id ? <>{open && <BriefButton />}{review && <ReviewButton />}</> : null;
}
function BriefButton() {
	const { open, state } = useContext(BriefContext);
	// Written in the background; the conversation stays usable and the brief opens beside it when it is ready.
	return <button type="button" className={`brief-button${state ? ` brief-${state}` : ""}`} disabled={!open || state === "writing"} onClick={() => open?.()}
		title="A one-page brief on this turn, written outside the conversation">
		<Icon name="info" />{state === "writing" ? "Writing the brief…" : state === "ready" ? "Read the brief" : "What do I need to know?"}</button>;
}
function ReviewButton() {
	const { review } = useContext(BriefContext);
	return <button type="button" className="brief-button" onClick={() => review?.()} title="Ask Pi to review this turn's changes with the code-review skill, reporting first">
		<Icon name="code" />Review the changes</button>;
}
function RewindButton({ message }: { message: ChatMessage }) {
	const { rewind } = useContext(RewindContext);
	return <button type="button" className="message-copy" disabled={!rewind} onClick={() => rewind?.(message)}
		title={!rewind ? "Rewind is available when Pi is idle" : message.role === "user" ? "Rewind to before this message, and edit it" : "Rewind to this reply"}
		aria-label={message.role === "user" ? "Rewind to before this message" : "Rewind to this reply"}><Icon name="rewind" /></button>;
}
/** Time of day, with the date when it is not today. */
function timeLabel(timestamp: number): string {
	if (!timestamp) return "";
	const date = new Date(timestamp), now = new Date(), time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (date.toDateString() === now.toDateString()) return time;
	return `${date.toLocaleDateString([], { day: "numeric", month: "short", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) })}, ${time}`;
}
function Time({ timestamp }: { timestamp: number }) {
	return timestamp ? <time dateTime={new Date(timestamp).toISOString()} title={new Date(timestamp).toLocaleString()}>{timeLabel(timestamp)}</time> : null;
}
function ToolStatus({ message }: { message?: ChatMessage }) {
	const tool = message?.tool;
	if (!tool) return null;
	return <span className={`tool-status tool-${tool.state}`}>
		<span>{tool.state === "running" ? "Running" : tool.state === "interrupted" ? "Stopped" : tool.state === "error" ? "Failed" : "Completed"}</span>
		{tool.state === "running" ? <Elapsed started={message!.timestamp} /> : tool.seconds !== undefined && <span>{tool.seconds.toFixed(1)}s</span>}
		{tool.exitCode !== undefined && <span>Exit {tool.exitCode}</span>}
	</span>;
}
/** One row per tool call a tool made, under its row: what the model said each was for, and how it went. */
function NestedCalls({ id, nested }: { id: string; nested: NonNullable<ChatMessage["nested"]> }) {
	const row = (call: NestedCall, index: number) => {
		const label = call.skills?.length ? call.skills.length === 1 ? "Read skill" : "Read skills" : call.name;
		const detail = call.skills?.length ? call.skills.join(", ") : call.description ?? toolArgumentPreview(call.name, call.arguments);
		return <Disclosure key={index} id={`nested:${id}:${index}`} className="nested-call"
			summary={<><strong>{label}</strong>
				<span className="tool-argument-preview">{call.description && !call.skills?.length ? <span className="tool-description">{detail}</span> : detail}</span>
				<span className={`tool-status tool-${call.status === "running" ? "running" : call.status === "error" ? "error" : call.status === "unfinished" ? "interrupted" : "done"}`}>
					{call.status === "running" ? <><span>Running</span>{call.started && <Elapsed started={call.started} />}</>
						: call.status === "error" ? <span>Failed</span> : call.status === "unfinished" ? <span>Stopped</span> : null}
					{call.status !== "running" && call.seconds !== undefined && <span>{call.seconds.toFixed(1)}s</span>}
				</span></>}>
			{call.error && <p className="nested-call-error">{call.error}</p>}
			{call.arguments ? <pre>{call.arguments}</pre> : <p className="muted">The arguments were too large to keep.</p>}
		</Disclosure>;
	};
	// Long scripts keep their latest calls in view, which include any still running.
	const calls = nested.calls, hidden = calls.length > 8 ? calls.length - 6 : 0;
	return <div className="nested-calls">
		{hidden > 0 && <Disclosure id={`nested:${id}:earlier`} className="nested-earlier" summary={`${hidden} earlier call${hidden === 1 ? "" : "s"}`}>
			{calls.slice(0, hidden).map(row)}</Disclosure>}
		{calls.slice(hidden).map((call, index) => row(call, hidden + index))}
		{calls.length >= 256 && <p className="muted">Calls after the first 256 were not recorded.</p>}
	</div>;
}
function ToolPill({ owner, call, result, sessionKey, source }: {
	owner: ChatMessage; call?: Extract<ChatBlock, { type: "toolCall" }>; result?: ChatMessage; sessionKey: string; source?: string;
}) {
	const name = call?.name ?? result?.toolName ?? "Tool";
	const skills = readSkills(name, call?.arguments);
	const nestedSkills = [...new Set(result?.nested?.calls.flatMap(call => call.skills ?? []) ?? [])];
	const resultFile = ["read", "edit", "write", "view_image"].includes(name)
		? result?.blocks.find(block => block?.type === "file") : undefined;
	const file = resultFile?.type === "file" ? resultFile.file : call?.file;
	const fileMessage = resultFile ? result!.id : owner.id;
	// What the call changed, and what an agent chose to show, stay visible instead of inside the collapsed call.
	const items = (result?.blocks ?? []).flatMap((block, index): WorkItem[] => block?.type === "diff" || block?.type === "document" || block?.type === "shown"
		? [{ id: `${result!.id}:${index}`, at: result!.timestamp, message: result!.id, source, block }] : []);
	const shown = items.find(item => item.block.type === "shown");
	if (shown) return <ReferenceContext value={{ message: result!.id, source }}><ShownSummary item={shown as WorkItem & { block: Extract<ChatBlock, { type: "shown" }> }} time={<Time timestamp={owner.timestamp} />} /></ReferenceContext>;
	const changes = items.map(item => item.block);
	const totals = changes.reduce((sum, block) => block.type === "diff" ? { added: sum.added + diffStats(block).added, removed: sum.removed + diffStats(block).removed } : sum, { added: 0, removed: 0 });
	const pill = <Disclosure id={`tool:${call?.id ?? result?.toolCallId ?? owner.id}`} className={`tool-card tool-pill${result?.isError ? " tool-error" : ""}`} data-tool-call={call?.id ?? result?.toolCallId}
		summary={<><span className="tool-icon">{skills.length || nestedSkills.length ? <Icon name="context" /> : "⌘"}</span><strong>{skills.length ? skills.length === 1 ? "Read skill" : "Read skills" : name}</strong>
			<span className="tool-argument-preview" title={call?.description ? toolArgumentPreview(name, call.arguments) : undefined}>
				{call?.description && <span className="tool-description">{call.description}{file ? " · " : ""}</span>}
				{skills.length ? `${skills.join(", ")} · ` : ""}{file
				? <ReferenceContext value={{ message: fileMessage, source }}><FileLink session={sessionKey} file={file} /></ReferenceContext>
				: call?.description ? null : nestedSkills.length ? `Skills: ${nestedSkills.join(", ")}` : toolArgumentPreview(name, call?.arguments)}</span>
			{(totals.added > 0 || totals.removed > 0) && <span className="change-stats">{totals.added > 0 && <span className="change-added">+{totals.added}</span>}{totals.removed > 0 && <span className="change-removed">−{totals.removed}</span>}</span>}
			<ToolStatus message={result} />
			{!result?.tool && <Time timestamp={owner.timestamp} />}
		</>}>
		{result && <ReferenceContext value={{ message: result.id, source }}>
			<div className="tool-output"><MessageBody message={result} sessionKey={sessionKey} source={source} omitFile={resultFile?.type === "file" ? resultFile.file.id : undefined} omitChanges />
				{result.tool?.processRunning && <p className="muted">Process{result.tool.processId ? ` #${result.tool.processId}` : ""} was running when this result was returned.</p>}
			</div>
		</ReferenceContext>}
		{call && <Disclosure id={`arguments:${call.id}`} className="tool-arguments" summary="Arguments"><pre>{call.arguments}</pre>
			{call.full && <AssetLink session={sessionKey} asset={call.full} />}
			{call.truncated && !call.full && <p className="muted">Preview only. Complete arguments exceed the viewer's asset limit.</p>}
		</Disclosure>}
	</Disclosure>;
	// A file edit's result is its change: one row that opens it. Other tools keep their own row too.
	if (items.length && !result?.isError && ["edit", "write", "apply_patch"].includes(name))
		return <div className="tool-changes">{items.map((item, index) => <WorkChip key={item.id} item={item} status={index === items.length - 1 ? <ToolStatus message={result} /> : undefined} />)}</div>;
	const nested = result?.nested?.calls.length ? <NestedCalls id={call?.id ?? result!.toolCallId ?? result!.id} nested={result.nested} /> : null;
	return items.length || nested ? <>{pill}{nested}{items.length > 0 && <div className="tool-changes">{items.map(item => <WorkChip key={item.id} item={item} />)}</div>}</> : pill;
}
type TextBlock = Extract<ChatBlock, { type: "text" | "thinking" }>;
function RenderedText({ message, block, sessionKey }: { message: ChatMessage; block: TextBlock; sessionKey: string }) {
	return <div className="markdown">{message.notice?.kind === "process" ? <CodeBlock><code>{block.text}</code></CodeBlock> : <Markdown
		remarkPlugins={markdownPlugins(message.links)} urlTransform={url => markdownUrl(message.links, url)}
		components={{
			pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
			a: ({ children, href, node }) => {
				const file = markdownFile(message.links, href);
				const label = node?.children.some(child => child.type === "element" && child.tagName === "img")
					? node.children.map(child => child.type === "text" ? child.value : child.type === "element" && child.tagName === "img" ? String(child.properties.alt ?? "Image") : "").join("") : children;
				return file ? <FileLink session={sessionKey} file={file}>{label}</FileLink>
					: href ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{label}</a> : <span>{label}</span>;
			},
			img: ({ alt, src }) => {
				const file = markdownFile(message.links, src);
				return file ? <FileLink session={sessionKey} file={file}>{alt || file.name}</FileLink>
					: src ? <a href={src} target="_blank" rel="noreferrer">{alt || "Open image"}</a> : <span>{alt}</span>;
			},
		}}>{block.text}</Markdown>}
		{block.full && <AssetLink session={sessionKey} asset={block.full} />}
		{block.truncated && !block.full && <p className="muted">Preview only. Complete output exceeds the viewer's asset limit.</p>}
	</div>;
}
function ThinkingGroup({ parts, sessionKey, source }: {
	parts: { message: ChatMessage; block: TextBlock; index: number }[]; sessionKey: string; source?: string;
}) {
	const active = parts.find(part => part.message.complete === false)?.message;
	const readable = parts.flatMap(part => {
		// Presentation only: retain native reasoning/signatures and join streamed text before removing SGR formatting
		// and the "Thinking:" label pi-tool-display saves into messages for its terminal view.
		const text = part.block.text.replace(/(?:\u001b\[|\u009b)[\d;:]*m/g, "").replace(/\u001b(?:\[[\d;:]*)?$|\u009b[\d;:]*$/, "")
			.replace(/^(?:\s*thinking:)+\s*/i, "");
		return text.trim() || part.block.full || part.block.truncated ? [{ ...part, block: { ...part.block, text } }] : [];
	});
	return <Disclosure id={`thinking:${parts[0]?.message.id}:${parts[0]?.index}`} className="tool-card thinking-pill"
		summary={<><Icon name="thinking" /><strong>Thinking</strong>
		{readable.length > 0 && <span className="tool-argument-preview">{thinkingPreview(readable[0]!.block.text)}</span>}
		{readable.length > 1 && <span className="thinking-count" title="Readable reasoning sections in this reply">{readable.length} sections</span>}
		{!active && !readable.length && <span className="thinking-count">No summary provided</span>}
		{active && <span className="tool-status" title="Elapsed response time, including network waiting—not measured reasoning time."><span>Elapsed</span><Elapsed started={active.timestamp} /></span>}</>}>
		<div className="thinking-output">{readable.length ? readable.map(({ message, block, index }) => <ReferenceContext key={`${message.id}:${index}`} value={{ message: message.id, source }}>
			<RenderedText message={message} block={block} sessionKey={sessionKey} />
		</ReferenceContext>) : <p className="muted">{active ? "Waiting for a reasoning summary…" : "No readable reasoning summary was included in this response."}</p>}</div>
	</Disclosure>;
}
function thinkingParts(messages: ChatMessage[]) {
	return messages.flatMap(message => message.blocks.flatMap((block, index) => block?.type === "thinking" ? [{ message, block, index }] : []));
}
function MessageBody({ message, sessionKey, source, results, omitFile, omitChanges }: {
	message: ChatMessage; sessionKey: string; source?: string; results?: Record<string, ChatMessage>; omitFile?: string;
	/** Changes shown beside the tool call rather than in its output. */
	omitChanges?: boolean;
}) {
	return <div className="message-body">
		{message.blocks.map((block, index) => {
			if (!block || isEmptyText(block)) return null;
			if (block.type === "file") return block.file.id === omitFile ? null : <FileLink key={index} session={sessionKey} file={block.file} />;
			if (block.type === "artifact") return <ArtifactLink key={index} session={sessionKey} id={block.id} label={block.label} />;
			if (block.type === "diff" || block.type === "document" || block.type === "shown")
				return omitChanges ? null : <WorkChip key={index} item={{ id: `${message.id}:${index}`, at: message.timestamp, message: message.id, source, block }} />;
			if (block.type === "text" && message.tool?.state === "running") return <LiveOutput key={index} text={block.text} />;
			if (block.type === "ledger") return <LedgerCard key={index} ledger={block.ledger} />;
			if (block.type === "image") return <AssetImage key={index} session={sessionKey} asset={block.asset} />;
			if (block.type === "toolCall") return <ToolPill key={index} owner={message} call={block} result={results?.[block.id]} sessionKey={sessionKey} source={source} />;
			if (block.type === "thinking") {
				if (message.blocks[index - 1]?.type === "thinking") return null;
				const end = message.blocks.findIndex((next, i) => i > index && next?.type !== "thinking");
				const parts = message.blocks.slice(index, end < 0 ? undefined : end).flatMap((next, i) => next?.type === "thinking" ? [{ message, block: next, index: index + i }] : []);
				return <ThinkingGroup key={index} parts={parts} sessionKey={sessionKey} source={source} />;
			}
			return <RenderedText key={index} message={message} block={block} sessionKey={sessionKey} />;
		})}
	</div>;
}
function SummaryCard({ message, sessionKey, source, faded }: { message: ChatMessage; sessionKey: string; source?: string; faded: string }) {
	const summary = message.summary!;
	const title = summary.kind === "branch" ? "Branch summary" : summary.kind === "handoff" ? "Context summarised for a model switch" : "Context compacted";
	const detail = [summary.tokensBefore && `from ${tokenFormat.format(summary.tokensBefore)} tokens`, summary.kind === "checkpoint" && "Codex checkpoint", summary.model]
		.filter(Boolean).join(" · ");
	return <ReferenceContext value={{ message: message.id, source }}><article className={`message message-summary summary-${summary.kind}${faded}`}>
		<Disclosure id={`summary:${message.id}`} className="summary-card"
			summary={<><Icon name="layers" /><strong>{title}</strong>{detail && <span className="summary-detail">{detail}</span>}<Time timestamp={message.timestamp} /></>}>
			<p className="summary-explanation">{summary.kind === "branch" ? "A summary of the branch you left, carried into this one."
				: summary.kind === "checkpoint" ? "Codex replaced the earlier messages, which are faded, with an encrypted checkpoint only Codex can read. Recent messages were kept as they were."
				: "From here, the model sees this summary instead of the earlier messages, which are faded. Recent messages were kept as they were."}</p>
			{summary.kind !== "checkpoint" && <MessageBody message={message} sessionKey={sessionKey} source={source} />}
			{(summary.cost !== undefined || summary.kind !== "checkpoint") && <div className="summary-footer">
				{summary.cost !== undefined && <span>Cost ${summary.cost.toFixed(2)}</span>}
				{summary.kind !== "checkpoint" && <CopyMarkdown message={message} sessionKey={sessionKey} />}</div>}
		</Disclosure>
	</article></ReferenceContext>;
}
export const MessageView = memo(function MessageView({ contextStart, ...props }: Parameters<typeof MessageRow>[0] & {
	/** The first message the model still sees word for word after the latest compaction. */
	contextStart?: boolean;
}) {
	const row = <MessageRow {...props} />;
	return contextStart ? <><div className="context-start" role="separator">Model context starts here</div>{row}</> : row;
});
function MessageRow({ message, sessionKey, source, results, thinking, traceContinues, summarised }: {
	message: ChatMessage; sessionKey: string; source?: string; results?: Record<string, ChatMessage>; thinking?: ChatMessage[];
	traceContinues?: boolean;
	/** The model no longer sees this message verbatim, only through a compaction summary. */
	summarised?: boolean;
}) {
	const time = <Time timestamp={message.timestamp} />, round = planRoundNotice(message), faded = summarised ? " message-summarised" : "";
	if (message.feedback) return null;
	if (message.summary) return <SummaryCard message={message} sessionKey={sessionKey} source={source} faded={faded} />;
	if (round) return <article className={`message message-plan-round${faded}`}><div className="plan-round-heading"><Icon name="plan" /><strong>Plan</strong>
		<span>Round {round.round} of {round.maxRounds}</span>{time}</div><p>{round.objective}</p></article>;
	if (message.notice || message.role === "note" && !message.blocks.some(block => block?.type === "ledger")) {
		const notice = message.notice;
		return <ReferenceContext value={{ message: message.id, source }}><article className={`message message-received${faded}`}>
			<Disclosure id={`notice:${message.id}`} className={`received-notice notice-${notice?.kind ?? "info"}`} initialOpen={!notice || notice.kind === "party" || notice.kind === "schedule" || notice.kind === "compaction"}
				summary={<><Icon name={notice?.kind === "party" || notice?.kind === "agent" ? "party" : notice?.kind === "process" ? "terminal" : notice?.kind === "work" ? "activity" : notice?.kind === "schedule" ? "clock" : notice?.kind === "compaction" ? "layers" : notice?.kind === "watch" ? "eye" : "info"} />
					<strong>{notice?.title ?? "Notification"}</strong>{notice?.detail && <span className="notice-detail">{notice.detail}</span>}{time}</>}>
				{notice?.kind === "schedule" && <div className="notice-metadata">
					<span title={new Date(notice.queuedAt!).toLocaleString()}>Queued {timeLabel(notice.queuedAt!)}</span>
					<span title={new Date(notice.dueAt!).toLocaleString()}>Due {timeLabel(notice.dueAt!)}</span>
				</div>}
				<MessageBody message={message} sessionKey={sessionKey} source={source} />
			</Disclosure>
		</article></ReferenceContext>;
	}
	const activityOnly = message.role === "tool" || isActivityOnly(message);
	const dictated = withoutDictationNote(message);
	if (dictated) message = dictated;
	return <ReferenceContext value={{ message: message.id, source }}>
		<article className={`message message-${message.role}${activityOnly ? " message-activity" : ""}${traceContinues ? " message-trace-tail" : ""}${faded}`}>
			{!activityOnly && <div className="message-heading"><span className={message.role === "assistant" ? "assistant-avatar" : "message-label"}>
				{message.role === "assistant" ? "π" : message.role === "user" ? source ? "Input" : "You" : "Note"}</span>
				{message.role === "assistant" && <strong>Pi</strong>}{time}
				{dictated && <span className="dictated-badge" title="Dictated. The agent was told speech recognition may have misheard some words."><Icon name="mic" />Dictated</span>}</div>}
			{thinking ? <div className="message-body"><ThinkingGroup parts={thinkingParts(thinking)} sessionKey={sessionKey} source={source} /></div>
				: message.role === "tool" ? <ToolPill owner={message} result={message} sessionKey={sessionKey} source={source} />
				: <MessageBody message={message} sessionKey={sessionKey} source={source} results={results} />}
			{!activityOnly && !thinking && <div className="message-actions"><CopyMarkdown message={message} sessionKey={sessionKey} />
				{!source && message.entryId && (message.role === "user" || message.role === "assistant") && message.complete !== false && <RewindButton message={message} />}
				{!source && message.role === "assistant" && <LatestBrief id={message.id} />}</div>}
		</article>
	</ReferenceContext>;
}
