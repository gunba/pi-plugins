import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { draftWithSender, registerGmailSendDraft } from "../manage/gmail-send.mjs";

const from = "owner@example.com", mime = "To: owner@example.com\r\nSubject: Home: Daily guide\r\nContent-Type: text/plain\r\n\r\nA synthetic message.";
const draft = { message: { raw: Buffer.from(mime).toString("base64url"), threadId: "thread-1" } };
function fixture(send) {
	let tool; const requests = [];
	registerGmailSendDraft({ registerTool: (name, definition, execute) => { tool = { name, definition, execute }; } }, async (path, options) => {
		requests.push([path, options]);
		return path === "/profile" ? { emailAddress: from } : options.query ? draft : options.method === "PUT" ? {} : send();
	}, z);
	return { tool, requests };
}

test("Gmail sends only the existing draft, with an explicit verified From address and sent-message receipt", async () => {
	const { tool, requests } = fixture(() => ({ id: "sent-1", threadId: "thread-1" }));
	assert.equal(tool.name, "send_draft");
	assert.equal(tool.definition.annotations.destructiveHint, true);
	assert.equal(tool.definition.annotations.idempotentHint, false);
	assert.equal(tool.definition.inputSchema.draftId.safeParse("").success, false);
	const reply = await tool.execute({ draftId: "draft-1", from });
	assert.deepEqual(requests.map(([path, options]) => [path, options.method ?? "GET", options.retry]), [
		["/profile", "GET", false], ["/drafts/draft-1", "GET", false], ["/drafts/draft-1", "PUT", false], ["/drafts/send", "POST", false],
	]);
	assert.equal(Buffer.from(requests[2][1].body.message.raw, "base64url").toString(), `From: ${from}\r\n${mime}`);
	assert.deepEqual(requests[3][1].body, { id: "draft-1" });
	assert.deepEqual(JSON.parse(reply.content[0].text), { sent: true, id: "sent-1", threadId: "thread-1", from });
});

test("a wrong Gmail account is rejected before the draft is changed or sent", async () => {
	const { tool, requests } = fixture(() => assert.fail("must not send"));
	const reply = await tool.execute({ draftId: "draft-1", from: "other@example.com" });
	assert.equal(requests.length, 1);
	assert.deepEqual(reply, { isError: true, content: [{ type: "text", text: "The requested From address is not this Gmail account. Nothing was sent." }] });
});

test("an uncertain Gmail delivery is not retried or reported as sent", async () => {
	let sends = 0;
	const { tool } = fixture(() => { sends++; throw Error("network lost after sending"); });
	const reply = await tool.execute({ draftId: "draft-1", from });
	assert.equal(sends, 1);
	assert.equal(reply.isError, true);
	assert.equal(reply.content[0].text, "Gmail did not confirm delivery. Search Sent and check whether the draft still exists before trying again. No automatic retry was made.");
});

test("sender rewriting removes folded duplicate From headers without changing the MIME body", () => {
	const raw = Buffer.from("From: Wrong\r\n <wrong@example.com>\r\n" + mime + "\r\n\xff", "latin1").toString("base64url");
	assert.equal(Buffer.from(draftWithSender(raw, from), "base64url").toString("latin1"), `From: ${from}\r\n${mime}\r\n\xff`);
	assert.throws(() => draftWithSender(raw, "owner@example.com\r\nBcc: other@example.com"), /Invalid draft or sender/);
});
