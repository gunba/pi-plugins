import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath, mkdir, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const rootFiles = new Set(["package.json", "package-lock.json", ".npmrc", "LICENSE", "README.md"]);
const omitted = new Set(["node_modules", "dist", "tests", "test"]);
const required = ["package.json", "package-lock.json", "pi-desk/package.json", "pi-desk/package-lock.json", "pi-desk/build.mjs"];
export interface SourceFile { path: string; data: Buffer; executable: number }
export interface SourceSnapshot {
	root: string; digest: string; files: SourceFile[]; plugins: string; desk: string; engine: string;
}

export function within(root: string, path: string): boolean {
	const part = relative(root, path);
	return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}
function include(path: string): boolean {
	if (rootFiles.has(path)) return true;
	const parts = path.split("/");
	return parts.length > 1 && parts[0]!.startsWith("pi-")
		&& parts.every(part => !part.startsWith(".") && !omitted.has(part))
		&& !/\.(?:test|spec)\.[cm]?[jt]sx?$|\.(?:log|ndjson)$/.test(path);
}
async function paths(root: string): Promise<string[]> {
	if (existsSync(join(root, ".git"))) {
		const result = await execute("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
		return [...new Set(result.stdout.split("\0").filter(include))].sort();
	}
	const found: string[] = [];
	const visit = async (directory: string, prefix = "") => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = prefix + entry.name;
			if (!prefix && !rootFiles.has(path) && !path.startsWith("pi-")) continue;
			if (prefix && !include(path)) continue;
			if (entry.isSymbolicLink()) throw new Error(`Runtime source cannot contain links: ${path}`);
			if (entry.isDirectory()) await visit(join(directory, entry.name), `${path}/`);
			else if (include(path)) found.push(path);
		}
	};
	await visit(root);
	return found.sort();
}
async function parallel<T, R>(values: T[], operation: (value: T) => Promise<R>): Promise<R[]> {
	const result = new Array<R>(values.length); let cursor = 0;
	const settled = await Promise.allSettled(Array.from({ length: Math.min(values.length, availableParallelism()) }, async () => {
		while (cursor < values.length) { const index = cursor++; result[index] = await operation(values[index]!); }
	}));
	const failed = settled.find(result => result.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
	return result;
}
export async function captureSource(directory: string): Promise<SourceSnapshot> {
	const root = await realpath(directory), names = await paths(root);
	for (const name of required) if (!names.includes(name)) throw new Error(`Runtime source is missing ${name}.`);
	const files = await parallel(names, async path => {
		const file = join(root, path), info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || !within(root, await realpath(file))) throw new Error(`Runtime source must be a regular file: ${path}`);
		return { path, data: await readFile(file), executable: info.mode & 0o111 };
	});
	const json = (path: string) => JSON.parse(files.find(file => file.path === path)!.data.toString("utf8"));
	const plugins = json("package.json"), desk = json("pi-desk/package.json");
	if (plugins.name !== "pi-plugins" || desk.name !== "@gunba/pi-desk") throw new Error("The runtime source must be the installed pi-plugins package.");
	const engine = desk.dependencies?.["@earendil-works/pi-coding-agent"];
	if (![plugins.version, desk.version, engine].every(value => typeof value === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value)))
		throw new Error("Runtime packages must declare exact versions, including the Pi SDK.");
	for (const [path, version] of [["package-lock.json", plugins.version], ["pi-desk/package-lock.json", desk.version]]) {
		if (json(path).packages?.[""]?.version !== version) throw new Error(`${path} does not match its package version.`);
	}
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(JSON.stringify([file.path, file.executable, file.data.length]) + "\n");
		hash.update(file.data);
	}
	return { root, files, digest: hash.digest("hex"), plugins: plugins.version, desk: desk.version, engine };
}
export async function writeSource(snapshot: SourceSnapshot, destination: string): Promise<void> {
	await parallel(snapshot.files, async file => {
		const path = join(destination, file.path);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(path, file.data, { flag: "wx", mode: 0o600 | file.executable });
	});
}
