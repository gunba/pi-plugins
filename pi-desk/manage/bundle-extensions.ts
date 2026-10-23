import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Plugin } from "esbuild";

/**
 * Pi compiles every TypeScript extension file with jiti each time a worker starts, unless jiti's cache in the temp
 * directory survives. On Windows each of those files is also scanned by Defender: the Work PC took 20 to 35 s to
 * start a conversation, and over two minutes right after an update. A release therefore ships each extension
 * precompiled into one JavaScript file, and its package manifest points Pi at those files.
 *
 * A bundle must behave exactly as its sources did:
 * - Packages Pi shares with extensions (its own and typebox) stay shared: Pi's loader maps them to its copies, so
 *   they are left as bare imports for that mapping to apply.
 * - Every other package import resolves to the file the source itself would load, from that source's folder.
 * - import.meta.url still names the original source file, which ships alongside, so files found relative to it
 *   (scripts, workers, package roots) and createRequire(import.meta.url) keep working.
 */
const SHARED = /^(?:@earendil-works|@mariozechner)\/(?:pi-coding-agent|pi-agent-core|pi-tui|pi-ai)(?:\/|$)|^typebox(?:\/|$)/;
export const BUNDLE_DIRECTORY = join("pi-desk", "dist", "extensions");
const SOURCE_URL = "__piSourceUrl", BUNDLE_URL = "__piBundleUrl";

export async function bundleExtensions(root: string, build: typeof import("esbuild").build): Promise<string[]> {
	root = resolve(root);
	const manifestPath = join(root, "package.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const entries: string[] = manifest.pi?.extensions ?? [];
	const outdir = join(root, BUNDLE_DIRECTORY);
	const fromBundle = (file: string) => {
		const path = relative(outdir, file).split(sep).join("/");
		return path.startsWith(".") ? path : `./${path}`;
	};
	const preserve: Plugin = { name: "preserve-sources", setup(context) {
		context.onResolve({ filter: /^[^./]/ }, async args => {
			if (args.kind === "entry-point" || args.path.startsWith("node:") || args.pluginData === "resolving") return;
			if (SHARED.test(args.path)) return { path: args.path, external: true };
			const found = await context.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: "resolving" });
			if (found.errors.length) return { errors: found.errors };
			if (!found.path || found.external) return { path: args.path, external: true };
			// A package file stays a separate module, loaded from where the source would load it.
			return found.path.includes(`${sep}node_modules${sep}`) ? { path: fromBundle(found.path), external: true } : undefined;
		});
		// Each module declares its original URL; the define below points its import.meta.url expressions at it.
		context.onLoad({ filter: /\.(?:[cm]?ts|[cm]?js)$/ }, async args => {
			if (args.path.includes(`${sep}node_modules${sep}`) && !entries.some(entry => resolve(root, entry) === args.path)) return;
			const source = await readFile(args.path, "utf8");
			if (!source.includes("import.meta")) return;
			const original = JSON.stringify(relative(outdir, args.path).split(sep).join("/"));
			return { contents: `const ${SOURCE_URL} = new URL(${original}, ${BUNDLE_URL}).href;\n${source}`,
				loader: /\.[cm]?ts$/.test(args.path) ? "ts" : "js", resolveDir: dirname(args.path) };
		});
	} };
	const bundled: string[] = [];
	for (const entry of entries) {
		// Named after the package, which is how settings and tool lists identify an extension's origin. A package's
		// further extensions (pi-agents has its subagents runtime) add their file name.
		const file = resolve(root, entry), parts = relative(root, file).split(sep);
		const taken = (candidate: string) => bundled.some(path => path.endsWith(`/${candidate}.mjs`));
		const base = parts[0] === "node_modules" ? parts[parts[1]!.startsWith("@") ? 2 : 1]! : parts[0]!;
		const name = taken(base) ? `${base}-${basename(file).replace(/\.[cm]?[jt]s$/, "")}` : base;
		if (taken(name)) throw new Error(`Two extensions would both be bundled as ${name}.mjs.`);
		const outfile = join(outdir, `${name}.mjs`);
		await build({ entryPoints: [file], outfile, bundle: true, platform: "node", format: "esm", target: "node22",
			define: { "import.meta.url": SOURCE_URL }, banner: { js: `const ${BUNDLE_URL} = import.meta.url;` },
			logLevel: "error", plugins: [preserve], legalComments: "none" });
		bundled.push(`./${relative(root, outfile).split(sep).join("/")}`);
	}
	manifest.pi.extensions = bundled;
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
	return bundled;
}

