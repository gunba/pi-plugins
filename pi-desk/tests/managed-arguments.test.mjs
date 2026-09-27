import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("managed account commands keep the configured proxy and allow an explicit override", () => {
	const entry = new URL("../src/host/managed.ts", import.meta.url).href;
	const run = args => JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		import { registerHooks } from "node:module";
		const entry = ${JSON.stringify(entry)};
		const module = source => ({ url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true });
		registerHooks({ resolve(specifier, context, next) {
			if (context.parentURL === entry && specifier.endsWith("/installation.ts"))
				return module('export const canonicalPath = value => value; export const selectedRuntime = () => ({id:"fixture",state:{active:"fixture"},installation:{directory:process.cwd(),agentDir:process.cwd(),cwd:process.cwd(),port:0,proxy:"http://proxy.example.com:8080"}});');
			if (context.parentURL === entry && specifier === "./cli.ts")
				return module('console.log(JSON.stringify(process.argv.slice(2)));');
			return next(specifier, context);
		}});
		process.argv = [process.execPath, "managed", ...${JSON.stringify(args)}];
		await import(entry);
	`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
	for (const command of ["signin", "signout"]) {
		const defaults = run([command]);
		assert.equal(defaults[defaults.indexOf("--proxy") + 1], "http://proxy.example.com:8080");
		const explicit = run([command, "--proxy=http://other.example.com:8080"]);
		assert.deepEqual(explicit.filter(value => value.startsWith("--proxy")), ["--proxy=http://other.example.com:8080"]);
	}
});
