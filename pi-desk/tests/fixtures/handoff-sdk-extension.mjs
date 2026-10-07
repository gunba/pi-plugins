import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";

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
				if (existsSync(join(ctx.cwd, "sdk-subagent-fixture"))) {
					try { await ctx.ui.input("Optional child question", "", { signal }); throw new Error("Away must not open another question."); }
					catch (error) { if (error.code !== "operator_unavailable") throw error;
						writeFileSync(join(ctx.cwd, "child-unavailable.json"), JSON.stringify({ code: error.code })); }
				}
				return { content: [{ type: "text", text: `Fixture answer: ${answer}` }], details: {} };
			} finally {
				const ended = once(child, "exit"); child.kill(); await ended;
			}
		} });
}
