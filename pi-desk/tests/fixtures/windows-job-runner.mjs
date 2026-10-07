import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const command = JSON.parse(readFileSync(process.argv[2], "utf8"));
const deadline = Date.now() + 30000;
while (!existsSync(command.admission)) {
	if (Date.now() >= deadline) throw Error("Job assignment was not admitted.");
	await delay(10);
}
const child = spawn(process.execPath, command.tests, { cwd: command.cwd, stdio: "inherit", windowsHide: true });
child.once("error", error => { console.error(error); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
