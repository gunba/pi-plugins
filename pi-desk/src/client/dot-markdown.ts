const FENCE = /^\s*(```|~~~)/;
const BLOCK = /^\s*([-*+]\s|\d+[.)]\s|>|#{1,6}\s|\|)|^\s{4}/;
const TABLE = /\|/;

/**
 * Dot's messages (ChatGPT messaging) as Markdown that renders the way ChatGPT shows them: there every line break starts
 * a new paragraph, and a line starting with "•" is a list item. In Markdown a single line break joins the lines, so
 * "•" lists and lines of text ran together into one paragraph. Code blocks, lists, quotes and tables keep their lines.
 */
export function dotMarkdown(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").split("\n"), out: string[] = [];
	let fence = false, previous = "";
	for (const raw of lines) {
		if (FENCE.test(raw)) { fence = !fence; out.push(raw); previous = raw; continue; }
		if (fence) { out.push(raw); continue; }
		const line = raw.replace(/^(\s*)[•◦▪‣]\s+/, "$1- ");
		// A text line after a text or list line starts its own paragraph; a table row after a table row stays in the table.
		if (line.trim() && previous.trim() && !BLOCK.test(line) && !(TABLE.test(line) && TABLE.test(previous))) out.push("");
		out.push(line); previous = line;
	}
	return out.join("\n");
}
