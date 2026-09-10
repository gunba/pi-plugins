import { posix, win32 } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";

const drivePath = /^[a-z]:[\\/]/i;
const windowsPath = (value: string) => drivePath.test(value) || value.startsWith("\\\\");
const control = /[\x00-\x1f\x7f]/;

/** Resolve file destinations, without accessing files or opening any target. */
export function fileLink(target: string, cwd: string, home = homedir()): string | undefined {
	if (!target || control.test(target) || target.startsWith("#") || target.startsWith("?")
		|| target.startsWith("//") || /^www\./i.test(target)
		|| /^\\\\[?.]\\/.test(target)) return;
	// A Windows drive is a path, not a URI scheme. Other schemes stay untouched.
	if (!drivePath.test(target) && /^[a-z][a-z\d+.-]*:/i.test(target)) return;
	const boundary = target.search(/[?#]/);
	const rawPath = boundary < 0 ? target : target.slice(0, boundary);
	const suffix = boundary < 0 ? "" : target.slice(boundary);
	// Do not turn encoded separators into a different path/UNC authority.
	if (/%(?:2f|5c)/i.test(rawPath)) return;
	let path: string;
	try { path = decodeURIComponent(rawPath.replace(/%(?![\da-f]{2})/gi, "%25")); }
	catch { return; }
	if (!path || control.test(path)) return;
	const windows = windowsPath(path) || windowsPath(cwd);
	const paths = windows ? win32 : posix;
	if (path === "~") path = home;
	else if (path.startsWith("~/") || (windows && path.startsWith("~\\"))) path = paths.join(home, path.slice(2));
	try {
		const absolute = paths.resolve(cwd, path);
		const url = pathToFileURL(absolute, { windows });
		url.pathname = url.pathname.replaceAll("&", "%26");
		if ((path.endsWith("/") || (windows && path.endsWith("\\"))) && !url.pathname.endsWith("/")) url.pathname += "/";
		// Preserve URI query/fragment semantics. Literal filename #/? must be encoded.
		const hash = suffix.indexOf("#");
		if (suffix.startsWith("?")) url.search = hash < 0 ? suffix : suffix.slice(0, hash);
		if (hash >= 0) url.hash = suffix.slice(hash);
		return url.href;
	} catch { return; }
}

type AstNode = {
	type: string;
	url?: string;
	identifier?: string;
	children?: AstNode[];
	position?: { start: { offset?: number }; end: { offset?: number } };
};

function skipSpace(text: string, offset: number, quoteDepth: number): number {
	let remaining = 0;
	while (offset < text.length) {
		const char = text[offset];
		if (char === "\n" || char === "\r") remaining = quoteDepth;
		else if (char === ">" && remaining > 0) { remaining--; offset++; continue; }
		else if (char !== " " && char !== "\t") break;
		offset++;
	}
	return offset;
}

/** Destination offsets only: leave link labels, titles and surrounding syntax intact. */
function destination(text: string, node: AstNode, quoteDepth: number): [number, number] | undefined {
	const start = node.position?.start.offset;
	const end = node.position?.end.offset;
	if (start === undefined || end === undefined) return;
	let cursor: number;
	if (node.type === "link") {
		if (text[start] !== "[") return; // Autolinks are not filesystem shorthand.
		const labelEnd = node.children?.at(-1)?.position?.end.offset ?? start + 1;
		if (text.slice(labelEnd, labelEnd + 2) !== "](") return;
		cursor = skipSpace(text, labelEnd + 2, quoteDepth);
	} else {
		cursor = start;
		while (cursor < end) {
			if (text[cursor] === "\\") { cursor += 2; continue; }
			if (text.slice(cursor, cursor + 2) === "]:") break;
			cursor++;
		}
		if (cursor >= end) return;
		cursor = skipSpace(text, cursor + 2, quoteDepth);
	}
	const angle = text[cursor] === "<";
	const from = angle ? ++cursor : cursor;
	let depth = 0;
	for (; cursor < end; cursor++) {
		const char = text[cursor];
		if (char === "\\" && /[!-/:-@[-`{-~]/.test(text[cursor + 1] ?? "")) { cursor++; continue; }
		if (angle) {
			if (char === ">") return [from, cursor];
		} else {
			if (/[ \t\r\n]/.test(char) || (char === ")" && depth === 0)) return [from, cursor];
			if (char === "(") depth++;
			if (char === ")") depth--;
		}
	}
	// Definitions without titles can end immediately after their destination.
	if (!angle && depth === 0 && node.type === "definition") return [from, end];
}

export function rewriteFileLinks(markdown: string, cwd: string, home?: string): string {
	if (!markdown.includes("](") && !markdown.includes("]:")) return markdown;
	const nodes: { node: AstNode; quoteDepth: number }[] = [];
	const referenced = new Set<string>();
	const stack = [{ node: fromMarkdown(markdown) as AstNode, quoteDepth: 0 }];
	while (stack.length) {
		const { node, quoteDepth } = stack.pop()!;
		if (node.type === "link" || node.type === "definition") nodes.push({ node, quoteDepth });
		if (node.type === "linkReference" && node.identifier) referenced.add(node.identifier);
		for (const child of node.children ?? []) {
			stack.push({ node: child, quoteDepth: quoteDepth + (node.type === "blockquote" ? 1 : 0) });
		}
	}
	const edits: { from: number; to: number; value: string }[] = [];
	for (const { node, quoteDepth } of nodes) {
		if (!node.url || (node.type === "definition" && !referenced.has(node.identifier ?? ""))) continue;
		const href = fileLink(node.url, cwd, home);
		if (!href) continue;
		const range = destination(markdown, node, quoteDepth);
		if (!range) continue;
		// Keep generated destinations valid in both bare and angle-bracket Markdown.
		const value = href.replace(/[()\\|]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
		edits.push({ from: range[0], to: range[1], value });
	}
	if (!edits.length) return markdown;
	const parts: string[] = [];
	let cursor = 0;
	for (const edit of edits.sort((a, b) => a.from - b.from)) {
		parts.push(markdown.slice(cursor, edit.from), edit.value);
		cursor = edit.to;
	}
	parts.push(markdown.slice(cursor));
	return parts.join("");
}
