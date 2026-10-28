import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

export default function (pi) {
	pi.registerTool({ name: "handoff_fixture", label: "Fixture", description: "Offline lifecycle fixture.",
		parameters: { type: "object", properties: {} },
		async execute(_id, _args, signal, _update, ctx) {
			const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
			await once(child, "spawn");
			writeFileSync(join(ctx.cwd, "child.json"), JSON.stringify({ pid: child.pid, owner: process.pid, session: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile() }));
			try {
				const answer = await ctx.ui.input("Lifecycle fixture", "", { signal });
				writeFileSync(join(ctx.cwd, "answer.json"), JSON.stringify({ answer }));
				return { content: [{ type: "text", text: `Fixture answer: ${answer}` }], details: {} };
			} finally {
				const ended = once(child, "exit"); child.kill(); await ended;
			}
		} });
}
