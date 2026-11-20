import assert from "node:assert/strict";
import test from "node:test";
import { plannedWatch } from "../tool.ts";

test("a wake_when that asks only for any change is left out, as leaving it out does that, and a real condition is kept", () => {
	const plan = wake_when => plannedWatch({ command: "date", every: 30, wake_when }, { cwd: "/tmp" }, undefined, { times: 0, commands: 0 }, () => "").wakeWhen;
	// Judged as a condition, "changed" woke an agent for some changes and not others, and it missed hours of results.
	for (const asked of ["changed", "any change", "When the output changes."]) assert.equal(plan(asked), undefined, asked);
	for (const asked of ["the output says DONE", "status changes to finished"]) assert.equal(plan(asked), asked);
});
