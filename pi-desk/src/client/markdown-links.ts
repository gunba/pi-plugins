import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../shared/protocol.ts";

type MarkdownNode = { type: string; url?: string; value?: string; children?: MarkdownNode[] };

/**
 * Match native Markdown destinations before the HTML renderer URI-encodes them. A path alone in backticks is also a
 * target when the host found it (host/file-links.ts); it becomes a link around the code.
 */
export function fileLinkPlugin(links: ChatMessage["links"]) {
	const targets = new Map(links?.map(link => [link.target, `#desk-file-${link.file.id}`]));
	return () => (tree: MarkdownNode): void => {
		const stack = [{ node: tree, linked: false }];
		while (stack.length) {
			const { node, linked } = stack.pop()!;
			if (node.url && ["link", "image", "definition"].includes(node.type)) {
				const target = targets.get(node.url);
				if (target) node.url = target;
			}
			const inside = linked || node.type === "link" || node.type === "linkReference";
			node.children?.forEach((child, index) => {
				const target = !inside && child.type === "inlineCode" && child.value ? targets.get(child.value) : undefined;
				if (target) node.children![index] = { type: "link", url: target, children: [child] };
				else stack.push({ node: child, linked: inside });
			});
		}
	};
}
export function markdownPlugins(links?: ChatMessage["links"]) {
	return [remarkGfm, fileLinkPlugin(links)];
}
export function markdownFile(links: ChatMessage["links"], href?: string) {
	return links?.find(link => `#desk-file-${link.file.id}` === href)?.file;
}
export function markdownUrl(links: ChatMessage["links"], url: string): string {
	return markdownFile(links, url) || /^(https?:|mailto:|tel:|#)/i.test(url) && !url.startsWith("#desk-file-") ? url : "";
}
