import { memo } from "react";
import Markdown from "react-markdown";
import type { ChatBlock, ChatMessage } from "../shared/protocol.ts";
import { FileLink } from "./file-view.tsx";
import { ReferenceContext } from "./reference-origin.tsx";
import { AssetImage, AssetLink } from "./assets.tsx";
import { ArtifactLink, DiffCard } from "./artifact-view.tsx";
import { CodeBlock, Elapsed, LiveOutput } from "./transcript-parts.tsx";
import { LedgerCard } from "./ledger-card.tsx";
import { Icon } from "./icons.tsx";
import { Disclosure } from "./disclosure.tsx";
import { planRoundNotice } from "./plan-round.ts";
import { readSkills } from "../shared/skill-activity.ts";
import { isActivityOnly, isEmptyText } from "./state.ts";
import { markdownPlugins, markdownFile, markdownUrl } from "./markdown-links.ts";

const timeLabel = (timestamp: number) => timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
function toolArgumentPreview(serialized?: string): string {
	try {
		const args = JSON.parse(serialized ?? "{}");
		const value = args.path ?? args.command ?? args.cmd ?? args.q ?? args.query;
		return typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, 160) : "";
	} catch { return ""; }
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
	return <Disclosure id={`tool:${call?.id ?? result?.toolCallId ?? owner.id}`} className={`tool-card tool-pill${result?.isError ? " tool-error" : ""}`} data-tool-call={call?.id ?? result?.toolCallId}
		summary={<><span className="tool-icon">{skills.length || nestedSkills.length ? <Icon name="context" /> : "⌘"}</span><strong>{skills.length ? skills.length === 1 ? "Read skill" : "Read skills" : name}</strong>
			<span className="tool-argument-preview">{skills.length ? `${skills.join(", ")} · ` : ""}{file
				? <ReferenceContext value={{ message: fileMessage, source }}><FileLink session={sessionKey} file={file} /></ReferenceContext>
				: nestedSkills.length ? `Skills: ${nestedSkills.join(", ")}` : toolArgumentPreview(call?.arguments)}</span>
			<ToolStatus message={result} />
			{!result?.tool && <time>{timeLabel(owner.timestamp)}</time>}
		</>}>
		{result && <ReferenceContext value={{ message: result.id, source }}>
			<div className="tool-output"><MessageBody message={result} sessionKey={sessionKey} source={source} omitFile={resultFile?.type === "file" ? resultFile.file.id : undefined} />
				{result.tool?.processRunning && <p className="muted">Process{result.tool.processId ? ` #${result.tool.processId}` : ""} was running when this result was returned.</p>}
			</div>
		</ReferenceContext>}
		{call && <Disclosure id={`arguments:${call.id}`} className="tool-arguments" summary="Arguments"><pre>{call.arguments}</pre>
			{call.full && <AssetLink session={sessionKey} asset={call.full} />}
			{call.truncated && !call.full && <p className="muted">Preview only. Complete arguments exceed the viewer's asset limit.</p>}
		</Disclosure>}
	</Disclosure>;
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
	return <Disclosure id={`thinking:${parts[0]?.message.id}:${parts[0]?.index}`} className="tool-card thinking-pill"
		summary={<><Icon name="thinking" /><strong>Thinking</strong>
		{parts.length > 1 && <span className="thinking-count" title="Reasoning sections in this reply">{parts.length} sections</span>}
		{active && <span className="tool-status" title="Elapsed response time, including network waiting—not measured reasoning time."><span>Elapsed</span><Elapsed started={active.timestamp} /></span>}</>}>
		<div className="thinking-output">{parts.map(({ message, block, index }) => <ReferenceContext key={`${message.id}:${index}`} value={{ message: message.id, source }}>
			<RenderedText message={message} block={block} sessionKey={sessionKey} />
		</ReferenceContext>)}</div>
	</Disclosure>;
}
function thinkingParts(messages: ChatMessage[]) {
	return messages.flatMap(message => message.blocks.flatMap((block, index) => block?.type === "thinking" ? [{ message, block, index }] : []));
}
function MessageBody({ message, sessionKey, source, results, omitFile }: {
	message: ChatMessage; sessionKey: string; source?: string; results?: Record<string, ChatMessage>; omitFile?: string;
}) {
	return <div className="message-body">
		{message.nested && <Disclosure id={`nested:${message.id}`} className="tool-card nested-tools"
			summary={<><Icon name="layers" />{message.nested.calls.length} nested tool calls{!message.nested.complete && " · partial record"}</>}>
			<ul>{message.nested.calls.map((call, index) => <li key={index}><span>{call.skills?.length ? `Read skill: ${call.skills.join(", ")}` : call.name}</span><small>{call.status}{call.seconds !== undefined && ` · ${call.seconds.toFixed(1)}s`}</small></li>)}</ul>
		</Disclosure>}
		{message.blocks.map((block, index) => {
			if (!block || isEmptyText(block)) return null;
			if (block.type === "file") return block.file.id === omitFile ? null : <FileLink key={index} session={sessionKey} file={block.file} />;
			if (block.type === "artifact") return <ArtifactLink key={index} session={sessionKey} id={block.id} label={block.label} />;
			if (block.type === "diff") return <DiffCard key={index} session={sessionKey} block={block} />;
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
export const MessageView = memo(function MessageView({ message, sessionKey, source, results, thinking, traceContinues }: {
	message: ChatMessage; sessionKey: string; source?: string; results?: Record<string, ChatMessage>; thinking?: ChatMessage[];
	traceContinues?: boolean;
}) {
	const time = timeLabel(message.timestamp), round = planRoundNotice(message);
	if (message.feedback) return null;
	if (round) return <article className="message message-plan-round"><div className="plan-round-heading"><Icon name="plan" /><strong>Plan</strong>
		<span>Round {round.round} of {round.maxRounds}</span><time>{time}</time></div><p>{round.objective}</p></article>;
	if (message.notice || message.role === "note" && !message.blocks.some(block => block?.type === "ledger")) {
		const notice = message.notice;
		return <ReferenceContext value={{ message: message.id, source }}><article className="message message-received">
			<Disclosure id={`notice:${message.id}`} className={`received-notice notice-${notice?.kind ?? "info"}`} initialOpen={!notice || notice.kind === "party" || notice.kind === "schedule"}
				summary={<><Icon name={notice?.kind === "party" || notice?.kind === "agent" ? "party" : notice?.kind === "process" ? "terminal" : notice?.kind === "work" ? "activity" : notice?.kind === "schedule" ? "clock" : "info"} />
					<strong>{notice?.title ?? "Notification"}</strong><time>{time}</time></>}>
				{notice?.kind === "schedule" && <div className="notice-metadata">
					<span title={new Date(notice.queuedAt!).toLocaleString()}>Queued {timeLabel(notice.queuedAt!)}</span>
					<span title={new Date(notice.dueAt!).toLocaleString()}>Due {timeLabel(notice.dueAt!)}</span>
				</div>}
				<MessageBody message={message} sessionKey={sessionKey} source={source} />
			</Disclosure>
		</article></ReferenceContext>;
	}
	const activityOnly = message.role === "tool" || isActivityOnly(message);
	return <ReferenceContext value={{ message: message.id, source }}>
		<article className={`message message-${message.role}${activityOnly ? " message-activity" : ""}${traceContinues ? " message-trace-tail" : ""}`}>
			{!activityOnly && <div className="message-heading"><span className={message.role === "assistant" ? "assistant-avatar" : "message-label"}>
				{message.role === "assistant" ? "π" : message.role === "user" ? source ? "Input" : "You" : "Note"}</span>
				{message.role === "assistant" && <strong>Pi</strong>}<time>{time}</time></div>}
			{thinking ? <div className="message-body"><ThinkingGroup parts={thinkingParts(thinking)} sessionKey={sessionKey} source={source} /></div>
				: message.role === "tool" ? <ToolPill owner={message} result={message} sessionKey={sessionKey} source={source} />
				: <MessageBody message={message} sessionKey={sessionKey} source={source} results={results} />}
		</article>
	</ReferenceContext>;
});
