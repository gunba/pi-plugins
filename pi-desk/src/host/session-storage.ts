import { existsSync, writeFileSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * The CLI defers a new JSONL file until the first assistant response. A durable
 * host also needs empty conversations and extension state. Seed the documented
 * native format, then reopen through the public manager API before binding Pi.
 * Caller already holds the session's exclusive lease.
 */
export function materializeSession(manager: SessionManager): void {
	const file = manager.getSessionFile();
	if (!file || existsSync(file)) return;
	const header = manager.getHeader();
	if (!header) throw new Error("Persistent session has no native header.");
	const leaf = manager.getLeafId();
	writeFileSync(file, [header, ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n", {
		flag: "wx", mode: 0o600,
	});
	manager.setSessionFile(file);
	if (leaf === null) manager.resetLeaf();
	else manager.branch(leaf);
}
