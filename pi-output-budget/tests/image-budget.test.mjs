import assert from "node:assert/strict";
import test from "node:test";
import { boundImages, IMAGE_REQUEST_BYTES, OMITTED_IMAGE_NOTE } from "../extensions/image-budget.ts";

test("a request keeps its newest images within the size limit and leaves older ones out", () => {
	// Work PC, 15 October: 57 images, 67 MB of base64, at 677k tokens; Anthropic refuses requests over 32 MB and
	// the SDK reported each attempt only as "Connection error."
	const image = index => ({ role: "toolResult", toolCallId: `call-${index}`, toolName: "view_image", isError: false, timestamp: index,
		content: [{ type: "text", text: `Viewed image ${index}` }, { type: "image", mimeType: "image/png", data: "x".repeat(1_174_000) }] });
	const history = Array.from({ length: 57 }, (_, index) => image(index));
	const bytes = messages => messages.flatMap(message => message.content).filter(part => part.type === "image").reduce((sum, part) => sum + part.data.length, 0);
	const bounded = boundImages(history);
	assert.ok(bytes(history) > 60_000_000 && bytes(bounded) <= IMAGE_REQUEST_BYTES);
	assert.equal(bounded.at(-1), history.at(-1), "the newest image is untouched");
	assert.equal(bounded[0].content[1].text, OMITTED_IMAGE_NOTE);
	assert.equal(bounded[0].content[0].text, "Viewed image 0", "the rest of the message stays");
	// Monotonic, and stable between steps: one more image moves the cut only when a step is due.
	const grown = boundImages([...history, image(57)]);
	assert.ok(grown.slice(0, 57).every((message, index) => message.content[1].type !== "image" || bounded[index].content[1].type === "image"));
	const small = history.slice(0, 10);
	assert.equal(boundImages(small), small, "an untroubled request is passed through as is");
});
