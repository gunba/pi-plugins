import { fromMarkdown } from "mdast-util-from-markdown";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { ChatMessage } from "../shared/protocol.ts";
import type { LocalFiles } from "./local-files.ts";

type Node = { type: string; url?: string; identifier?: string; value?: string; children?: Node[] };

/** Folders at the root of this computer, by name: a route such as `/api/state` in backticks names none, so stays code. */
const roots = new Map<string, boolean>();
const rootExists = (name: string) => {
	if (!roots.has(name)) roots.set(name, existsSync(`/${name}`));
	return roots.get(name)!;
};
/**
 * An absolute path alone in backticks, with an optional `:line`. Drive and home paths are taken as written, without
 * touching the disk, since a mapped drive can take seconds to answer; other POSIX paths count when their first folder
 * exists. Commands (a space before a flag), globs and quoted text stay code.
 */
function codePath(value: string): { path: string; line?: number } | undefined {
	const text = value.trim();
	if (text.length > 1000 || /["<>|*?\r\n]/.test(text) || /\s--?[a-z]/i.test(text) || /\s\/[a-z]/i.test(text)) return;
	const located = /^(.+?):([1-9]\d{0,6})(?::\d+)?$/.exec(text);
	const path = located && !/^[a-z]$/i.test(located[1]!) ? located[1]! : text, line = located && path !== text ? Number(located[2]) : undefined;
	if (process.platform === "win32" ? /^[a-z]:[\\/]/i.test(path) : /^\/[^/\s]/.test(path) && rootExists(path.split("/")[1]!)) return { path, line };
	if (/^~[\\/]./.test(path)) return { path, line };
}
/** Paths alone in backticks in a reply, by the code's text, which the browser shows as links (markdown-links.ts). */
function codePaths(text: string): { code: string; path: string; line?: number }[] {
	const found: { code: string; path: string; line?: number }[] = [], stack: { node: Node; linked: boolean }[] = [{ node: fromMarkdown(text) as Node, linked: false }];
	while (stack.length && found.length < 64) {
		const { node, linked } = stack.pop()!;
		const target = node.type === "inlineCode" && !linked && node.value ? codePath(node.value) : undefined;
		if (target) found.push({ code: node.value!, ...target });
		const inside = linked || node.type === "link" || node.type === "linkReference";
		for (const child of node.children ?? []) stack.push({ node: child, linked: inside });
	}
	return found;
}

/** Browser references only; neither the native messages nor their model input are rewritten. */
export function projectFileLinks(message: ChatMessage, files: LocalFiles, cwd: string): ChatMessage {
	const links: NonNullable<ChatMessage["links"]> = [];
	const blocks = message.blocks.map(block => {
		if (block.type === "diff") return { ...block, file: block.action === "deleted" || block.path === "Edited file" ? undefined : files.observePath(block.movePath ?? block.path, cwd) };
		if (block.type === "document") return { ...block, file: files.observePath(block.change.path, cwd) };
		if (block.type === "shown") return { ...block, files: block.shown.items.map(item => item.path ? files.observePath(item.path, cwd) ?? null : null) };
		if (block.type !== "text" && block.type !== "thinking") return block;
		let text = block.text;
		if (message.role === "user" && text.includes("Attached files on the host:")) {
			text = text.replace(/^- ("(?:[^"\\]|\\.)*") \(\d+ bytes\): ("(?:[^"\\]|\\.)*")$/gm, (original, nameJson, pathJson) => {
				try {
					const name = JSON.parse(nameJson), path = JSON.parse(pathJson);
					if (typeof name !== "string" || typeof path !== "string" || !/[\\/]desk[\\/]attachments[\\/][a-f0-9]{64}[\\/][a-f0-9]{64}[\\/]attachment\.[a-z0-9]+$/i.test(path)) return original;
					if (!files.observePath(path, cwd, name)) return original;
					return `- [${name.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ")}](${pathToFileURL(path).href.replaceAll("(", "%28").replaceAll(")", "%29")})`;
				} catch { return original; }
			});
		}
		if (message.role !== "user" && /`\s*(?:[a-z]:[\\/]|~[\\/]|\/)/i.test(text)) for (const { code, path, line } of codePaths(text)) {
			if (links.length >= 64 || links.some(link => link.target === code)) continue;
			const file = files.observePath(path, cwd, undefined, line);
			if (file) links.push({ target: code, file });
		}
		if (!text.includes("](") && !text.includes("]:") && !/<file:/i.test(text)) return { ...block, text };
		const stack = [fromMarkdown(text) as Node], definitions = new Map<string, string>(), references = new Set<string>(), targets = new Set<string>();
		while (stack.length) {
			const node = stack.pop()!;
			if ((node.type === "link" || node.type === "image") && node.url) targets.add(node.url);
			if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier, node.url);
			if ((node.type === "linkReference" || node.type === "imageReference") && node.identifier) references.add(node.identifier);
			stack.push(...node.children ?? []);
		}
		for (const id of references) if (definitions.has(id)) targets.add(definitions.get(id)!);
		for (const target of targets) {
			if (links.length >= 64 || links.some(link => link.target === target)) continue;
			const file = files.observe(target, cwd);
			if (file) links.push({ target, file });
		}
		return { ...block, text };
	});
	return { ...message, blocks, ...(links.length ? { links } : {}) };
}
