import { getMarkdownTheme, type Theme, type ToolDefinition, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { safeWorkText } from "../pi-work-ui/view.ts";

type PartyTool = "send" | "members" | "read";
type Label = (id: string) => string;
type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
type RenderResult = Parameters<NonNullable<ToolDefinition["renderResult"]>>[0];
const preview = (text: string) => safeWorkText(text, true).split("\n").find(line => line.trim())?.trim() ?? "";
const rows = (lines: string[]): Component => ({ invalidate() {}, render: width => lines.map(line => truncateToWidth(line, width, "…")) });
function messageBody(text: string, expanded: boolean): Component {
	const md = new Markdown(safeWorkText(expanded ? text : text.split("\n").slice(0, 6).join("\n"), true), 0, 0, getMarkdownTheme());
	return expanded ? md : { invalidate: () => md.invalidate(), render: width => md.render(width).filter(line => line.trim()).slice(0, 2).map(line => truncateToWidth(line, width, "…")) };
}

export function renderPartyCall(kind: PartyTool, args: { to?: string; message?: string }, theme: Theme, context: RenderContext, label: Label): Component {
	const to = typeof args.to === "string" ? args.to : "";
	const title = kind === "send" ? `${to === "all" ? "Party" : "Direct"} → ${to === "all" ? "everyone" : to ? label(to) : "…"}` : kind === "members" ? "Party members" : "Peer inbox";
	const heading = theme.fg("toolTitle", theme.bold(safeWorkText(title)));
	if (kind !== "send" || typeof args.message !== "string") return rows([heading]);
	const container = new Container();
	container.addChild(rows([heading]));
	container.addChild(messageBody(args.message, context.expanded));
	return container;
}

export function renderPartyResult(kind: PartyTool, result: RenderResult, options: ToolRenderResultOptions, theme: Theme, context: RenderContext, label: Label): Component {
	const raw = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
	if (context.isError) return options.expanded ? new Text(theme.fg("error", safeWorkText(raw, true)), 0, 0) : rows([theme.fg("error", preview(raw) || "Party operation failed")]);
	if (options.isPartial) return rows([theme.fg("muted", kind === "send" ? "Sending…" : "Reading…")]);
	let value;
	try { value = JSON.parse(raw); }
	catch { return new Text(safeWorkText(raw, true), 0, 0); }
	let lines: string[];
	if (kind === "send" && Array.isArray(value?.queued)) {
		const wake = (context.args as { wake?: boolean })?.wake !== false ? "reply requested" : "FYI · no wake";
		lines = [`Queued for ${value.queued.length} ${value.queued.length === 1 ? "recipient" : "recipients"} · ${wake}`];
		if (options.expanded) for (const receipt of value.queued) lines.push(`→ ${label(String(receipt.to))}`);
	} else if (kind === "members" && Array.isArray(value)) {
		lines = value.map(peer => `${peer.label}${peer.self ? " (you)" : ""} · ${peer.state}`);
		if (!lines.length) lines.push("No party members.");
	} else if (kind === "read" && Array.isArray(value)) {
		lines = value.map(message => `${message.label || label(String(message.sender))}${message.kind === "invite" ? ` · invitation to ${message.invitedParty}` : ""}: ${options.expanded ? message.message : preview(String(message.message))}`);
		if (!lines.length) lines.push("No unread party messages.");
	} else lines = [raw];
	const display = lines.map(line => theme.fg("toolOutput", safeWorkText(line, true)));
	return options.expanded ? new Text(display.join("\n"), 0, 0) : rows(display);
}

export function renderPartyNotice(message: { content: unknown }, options: { expanded: boolean }, theme: Theme): Component {
	const raw = typeof message.content === "string" ? message.content : "";
	const [header = "Party message", ...body] = raw.split("\n");
	const container = new Container();
	container.addChild(rows([theme.fg("accent", safeWorkText(header.replace(/ \([0-9a-f-]{36}\)$/i, "")))]));
	container.addChild(messageBody(body.join("\n"), options.expanded));
	return container;
}
