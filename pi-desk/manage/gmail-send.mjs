/** Set one explicit sender without re-encoding MIME bodies or attachments. */
export function draftWithSender(raw, from) {
	if (typeof raw !== "string" || !raw || typeof from !== "string" || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from)) throw Error("Invalid draft or sender.");
	const message = Buffer.from(raw, "base64url").toString("latin1"), boundary = /\r?\n\r?\n/.exec(message);
	if (!boundary) throw Error("Draft has no MIME header boundary.");
	const header = message.slice(0, boundary.index).replace(/^From:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*\r?\n?/gmi, "").replace(/\r?\n/g, "\r\n");
	return Buffer.from(`From: ${from}\r\n${header}\r\n\r\n${message.slice(boundary.index + boundary[0].length)}`, "latin1").toString("base64url");
}

/** Add sending to the existing Gmail MCP adapter, reusing its request/auth implementation and granted compose scope. */
export function registerGmailSendDraft(server, gmailRequest, z) {
	server.registerTool("send_draft", {
		title: "Send Gmail draft",
		description: "Send an existing Gmail draft to its To, Cc and Bcc recipients, explicitly setting From to the authenticated Gmail address. Use only for an authorized message or scheduled job. The draft is consumed. If delivery is uncertain, search Sent before retrying; never recreate a draft just to retry a send.",
		inputSchema: { draftId: z.string().min(1).max(300).describe("ID returned by create_draft or list_drafts."), from: z.string().email().describe("Required sender; must match this Gmail account's primary address.") },
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	}, async ({ draftId, from }) => {
		try {
			const profile = await gmailRequest("/profile", { retry: false });
			if (typeof profile?.emailAddress !== "string" || profile.emailAddress.toLowerCase() !== from.toLowerCase())
				return { isError: true, content: [{ type: "text", text: "The requested From address is not this Gmail account. Nothing was sent." }] };
			const path = `/drafts/${encodeURIComponent(draftId)}`, draft = await gmailRequest(path, { query: { format: "raw" }, retry: false });
			const raw = draftWithSender(draft?.message?.raw, from);
			await gmailRequest(path, { method: "PUT", body: { message: { raw, ...(typeof draft.message.threadId === "string" ? { threadId: draft.message.threadId } : {}) } }, retry: false });
			const message = await gmailRequest("/drafts/send", { method: "POST", body: { id: draftId }, retry: false });
			if (!message || typeof message.id !== "string" || !message.id) throw Error("Gmail did not return a sent-message ID.");
			return { content: [{ type: "text", text: JSON.stringify({ sent: true, id: message.id, threadId: message.threadId, from }) }] };
		} catch {
			return { isError: true, content: [{ type: "text", text: "Gmail did not confirm delivery. Search Sent and check whether the draft still exists before trying again. No automatic retry was made." }] };
		}
	});
}
