import { fromMarkdown } from "mdast-util-from-markdown";
import { pathToFileURL } from "node:url";
import type { ChatMessage } from "../shared/protocol.ts";
import type { LocalFiles } from "./local-files.ts";

type Node = { type: string; url?: string; identifier?: string; children?: Node[] };

/** Browser references only; neither the native messages nor their model input are rewritten. */
export function projectFileLinks(message: ChatMessage, files: LocalFiles, cwd: string): ChatMessage {
	const links: NonNullable<ChatMessage["links"]> = [];
	const blocks = message.blocks.map(block => {
		if (block.type === "diff") return { ...block, file: block.action === "deleted" || message.toolName === "edit" ? undefined : files.observePath(block.movePath ?? block.path, cwd) };
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
