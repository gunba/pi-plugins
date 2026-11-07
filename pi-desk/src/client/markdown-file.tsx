import { memo, useEffect, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import type { FileInfo, FileReference, FileTextPage } from "../shared/files.ts";
import { api } from "./connection.ts";
import { markdownPlugins, markdownUrl } from "./markdown-links.ts";
import { useReferenceQuery } from "./reference-origin.tsx";
import { CodeBlock } from "./transcript-parts.tsx";

/** Files Desk shows formatted, as Markdown, rather than as text. */
export const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd)$/i;
/** How much of a file is read to format it; the file preview has the rest of a longer one. */
const READ_BYTES = 512 * 1024;
/** How much of a document the work pane shows; its expanded view shows the whole. */
const PANE_CHARS = 6_000;

const PLUGINS = markdownPlugins();
// Only web, mail and phone links survive (markdown-links.ts): a file's relative links name places the reader can't reach.
const url = (value: string) => markdownUrl(undefined, value);
// As in messages, images are links rather than fetched into the page.
const COMPONENTS: Components = {
	pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
	a: ({ children, href }) => href ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
	img: ({ alt, src }) => src ? <a href={src} target="_blank" rel="noreferrer">{alt || "Open image"}</a> : <span>{alt}</span>,
};

/** Markdown text formatted as Desk formats messages. */
export const MarkdownText = memo(function MarkdownText({ text, className }: { text: string; className?: string }) {
	return <div className={`markdown${className ? ` ${className}` : ""}`}><Markdown remarkPlugins={PLUGINS} urlTransform={url} components={COMPONENTS}>{text}</Markdown></div>;
});

/** The start of a document, cut at a paragraph and with any open code block closed, so it still formats. */
function opening(text: string, chars: number): string {
	const paragraph = text.lastIndexOf("\n\n", chars);
	const cut = text.slice(0, paragraph > chars / 2 ? paragraph : chars);
	return (cut.match(/^\s*(```|~~~)/gm)?.length ?? 0) % 2 ? cut + "\n```" : cut;
}

/** A Markdown file on the agent's computer, formatted as it is now: in the work pane its start, expanded the whole. */
export function MarkdownFile({ session, file, whole }: { session: string; file: FileReference; whole?: boolean }) {
	const origin = useReferenceQuery();
	const [read, setRead] = useState<{ text: string; more: boolean }>(), [error, setError] = useState("");
	useEffect(() => {
		let live = true;
		setRead(undefined); setError("");
		void (async () => {
			const info = await api<FileInfo>(`/sessions/${session}/files/${file.id}?${origin}`);
			if (info.kind !== "text") throw new Error("It isn't a text file.");
			let text = "", offset: number | null = 0;
			while (offset !== null && offset < READ_BYTES && live) {
				const params = new URLSearchParams(origin);
				params.set("version", info.version); params.set("offset", String(offset));
				const page: FileTextPage = await api<FileTextPage>(`/sessions/${session}/files/${file.id}/text?${params}`);
				text += page.text; offset = page.next;
			}
			if (live) setRead({ text, more: offset !== null });
		})().catch(reason => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
		return () => { live = false; };
	}, [session, file.id, origin]);
	if (error) return <p className="muted work-note">The file can't be read now: {error}</p>;
	if (!read) return <p className="muted work-note">Loading {file.name}…</p>;
	const cut = !whole && read.text.length > PANE_CHARS;
	return <>
		<MarkdownText text={cut ? opening(read.text, PANE_CHARS) : read.text} className="shown-markdown" />
		{cut ? <p className="muted work-note">Continued in the expanded view.</p>
			: read.more && <p className="muted work-note">Shown up to {READ_BYTES / 1024} KB; the file's preview has the rest.</p>}
	</>;
}
