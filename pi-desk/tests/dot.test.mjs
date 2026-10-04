import assert from "node:assert/strict";
import test from "node:test";
import { dotMessages } from "../src/host/dot.ts";

test("Dot authors are identified by room membership when both transport roles are user", () => {
	const members = [{ account_user_id: "owner", name: "Owner" }, { account_user_id: "cloud", aeon_id: "dot", name: "Dot" }];
	const items = [
		{ id: "one", role: "user", account_user_id: "owner", created_at: "2026-10-03T00:00:00Z", content: { text: "Hello" } },
		{ id: "two", role: "user", account_user_id: "cloud", created_at: "2026-10-03T00:00:01Z", content: { text: "Ready." } },
	];
	assert.deepEqual(dotMessages(items, members, "dot").map(message => [message.author, message.text]), [["owner", "Hello"], ["dot", "Ready."]]);
});
