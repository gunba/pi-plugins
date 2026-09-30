import type { ChatMessage } from "../shared/protocol.ts";

type MarkdownNode = { type: string; url?: string; children?: MarkdownNode[] };

/** Match native Markdown destinations before the HTML renderer URI-encodes them. */
export function fileLinkPlugin(links: ChatMessage["links"]) {
	const targets = new Map(links?.map(link => [link.target, `#desk-file-${link.file.id}`]));
	return () => (tree: MarkdownNode): void => {
		const stack = [tree];
		while (stack.length) {
			const node = stack.pop()!;
			if (node.url && ["link", "image", "definition"].includes(node.type)) {
				const target = targets.get(node.url);
				if (target) node.url = target;
			}
			stack.push(...node.children ?? []);
		}
	};
}
export function markdownFile(links: ChatMessage["links"], href?: string) {
	return links?.find(link => `#desk-file-${link.file.id}` === href)?.file;
}
export function markdownUrl(links: ChatMessage["links"], url: string): string {
	return markdownFile(links, url) || /^(https?:|mailto:|tel:|#)/i.test(url) && !url.startsWith("#desk-file-") ? url : "";
}
