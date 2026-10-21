import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { homeFolder } from "../src/host/local-path.ts";

test("a new conversation's folder of ~ is the home folder, not ~ under the folder Desk started from", () => {
	// An agent on another computer asked for "~" and Desk tried …/pi-plugins/~.
	assert.equal(homeFolder("~"), homedir());
	assert.equal(homeFolder(" ~/Projects "), join(homedir(), "Projects"));
	assert.equal(homeFolder("Projects"), join(homedir(), "Projects"));
	assert.equal(homeFolder(join(homedir(), "x")), join(homedir(), "x"));
});
