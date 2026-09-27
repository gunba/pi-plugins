import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("./windows-exec.cs", import.meta.url));
let building: Promise<string> | undefined;

/** Framework's compiler is part of Windows; no downloaded binary or elevation. */
export function windowsExecHelper(): Promise<string> {
	return building ??= buildHelper().catch(error => {
		building = undefined;
		throw error;
	});
}

async function buildHelper(): Promise<string> {
	const hash = createHash("sha256").update(await readFile(source)).digest("hex");
	const directory = join(process.env.LOCALAPPDATA ?? join(homedir(), ".pi", "cache"), "pi", "exec");
	const executable = join(directory, `${hash}.exe`);
	if (existsSync(executable)) return executable;
	const root = process.env.SystemRoot ?? "C:\\Windows";
	const compiler = ["Framework64", "Framework"]
		.map(arch => win32.join(root, "Microsoft.NET", arch, "v4.0.30319", "csc.exe"))
		.find(path => existsSync(path));
	if (!compiler) throw new Error("Windows managed execution requires the Windows .NET Framework C# compiler.");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = await mkdtemp(join(directory, "build-"));
	const output = join(temporary, "exec.exe");
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(compiler, ["/nologo", "/target:exe", "/platform:anycpu", `/out:${output}`, source],
				{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			let diagnostics = "";
			const collect = (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); };
			child.stdout.on("data", collect);
			child.stderr.on("data", collect);
			const timer = setTimeout(() => { child.kill(); reject(new Error("Windows process-helper compilation timed out.")); }, 30_000);
			child.once("error", error => { clearTimeout(timer); reject(error); });
			child.once("close", code => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else reject(new Error(`Windows process-helper compilation failed (${code}): ${diagnostics.trim()}`));
			});
		});
		try { await rename(output, executable); }
		catch (error) { if (!existsSync(executable)) throw error; }
		return executable;
	} finally {
		await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}
