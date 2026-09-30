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
import { planRoundNotice } from "./plan-round.ts";
import { isActivityOnly } from "./state.ts";
import { fileLinkPlugin, markdownFile, markdownUrl } from "./markdown-links.ts";

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
	const resultFile = ["read", "edit", "write", "view_image"].includes(name)
		? result?.blocks.find(block => block?.type === "file") : undefined;
	const file = resultFile?.type === "file" ? resultFile.file : call?.file;
	const fileMessage = resultFile ? result!.id : owner.id;
	return <details className={`tool-card tool-pill${result?.isError ? " tool-error" : ""}`} data-tool-call={call?.id ?? result?.toolCallId}>
		<summary><span className="tool-icon">⌘</span><strong>{name}</strong>
			<span className="tool-argument-preview">{file
				? <ReferenceContext value={{ message: fileMessage, source }}><FileLink session={sessionKey} file={file} /></ReferenceContext>
				: toolArgumentPreview(call?.arguments)}</span>
			<ToolStatus message={result} />
			{!result?.tool && <time>{timeLabel(owner.timestamp)}</time>}
		</summary>
		{result && <ReferenceContext value={{ message: result.id, source }}>
			<div className="tool-output"><MessageBody message={result} sessionKey={sessionKey} source={source} omitFile={resultFile?.type === "file" ? resultFile.file.id : undefined} />
				{result.tool?.processRunning && <p className="muted">Process{result.tool.processId ? ` #${result.tool.processId}` : ""} was running when this result was returned.</p>}
			</div>
		</ReferenceContext>}
		{call && <details className="tool-arguments"><summary>Arguments</summary><pre>{call.arguments}</pre>
			{call.full && <AssetLink session={sessionKey} asset={call.full} />}
			{call.truncated && !call.full && <p className="muted">Preview only. Complete arguments exceed the viewer's asset limit.</p>}
		</details>}
	</details>;
}
function MessageBody({ message, sessionKey, source, results, omitFile }: {
	message: ChatMessage; sessionKey: string; source?: string; results?: Record<string, ChatMessage>; omitFile?: string;
}) {
	return <div className="message-body">
		{message.nested && <details className="tool-card nested-tools">
			<summary><Icon name="layers" />{message.nested.calls.length} nested tool calls{!message.nested.complete && " · partial record"}</summary>
			<ul>{message.nested.calls.map((call, index) => <li key={index}><span>{call.name}</span><small>{call.status}{call.seconds !== undefined && ` · ${call.seconds.toFixed(1)}s`}</small></li>)}</ul>
		</details>}
		{message.blocks.map((block, index) => {
			if (!block) return null;
			if (block.type === "file") return block.file.id === omitFile ? null : <FileLink key={index} session={sessionKey} file={block.file} />;
			if (block.type === "artifact") return <ArtifactLink key={index} session={sessionKey} id={block.id} label={block.label} />;
			if (block.type === "diff") return <DiffCard key={index} session={sessionKey} block={block} />;
			if (block.type === "text" && message.tool?.state === "running") return <LiveOutput key={index} text={block.text} />;
			if (block.type === "ledger") return <LedgerCard key={index} ledger={block.ledger} />;
			if (block.type === "image") return <AssetImage key={index} session={sessionKey} asset={block.asset} />;
			if (block.type === "toolCall") return <ToolPill key={index} owner={message} call={block} result={results?.[block.id]} sessionKey={sessionKey} source={source} />;
			const rendered = <div className="markdown"><Markdown
				remarkPlugins={[fileLinkPlugin(message.links)]}
				urlTransform={url => markdownUrl(message.links, url)}
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
				}}>{block.text}</Markdown>
				{block.full && <AssetLink session={sessionKey} asset={block.full} />}
				{block.truncated && !block.full && <p className="muted">Preview only. Complete output exceeds the viewer's asset limit.</p>}
			</div>;
			return block.type === "thinking" ? <details className="tool-card" key={index}><summary>Thinking</summary>{rendered}</details> : <div key={index}>{rendered}</div>;
		})}
	</div>;
}
export const MessageView = memo(function MessageView({ message, sessionKey, source, results }: {
	message: ChatMessage; sessionKey: string; source?: string; results?: Record<string, ChatMessage>;
}) {
	const time = timeLabel(message.timestamp), round = planRoundNotice(message);
	if (round) return <article className="message message-plan-round"><div className="plan-round-heading"><Icon name="plan" /><strong>Plan</strong>
		<span>Round {round.round} of {round.maxRounds}</span><time>{time}</time></div><p>{round.objective}</p></article>;
	const activityOnly = message.role === "tool" || isActivityOnly(message);
	return <ReferenceContext value={{ message: message.id, source }}>
		<article className={`message message-${message.role}${activityOnly ? " message-activity" : ""}`}>
			{!activityOnly && <div className="message-heading"><span className={message.role === "assistant" ? "assistant-avatar" : "message-label"}>
				{message.role === "assistant" ? "π" : message.role === "user" ? source ? "Input" : "You" : "Note"}</span>
				{message.role === "assistant" && <strong>Pi</strong>}<time>{time}</time></div>}
			{message.role === "tool" ? <ToolPill owner={message} result={message} sessionKey={sessionKey} source={source} />
				: <MessageBody message={message} sessionKey={sessionKey} source={source} results={results} />}
		</article>
	</ReferenceContext>;
});
