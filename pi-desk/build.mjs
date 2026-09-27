import { build } from "esbuild";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
rmSync(resolve(root, "dist/host"), { recursive: true, force: true });
const host = await build({
  absWorkingDir: root,
  entryPoints: ["src/host/cli.ts", "src/host/worker.ts", "src/host/catalog-worker.ts"],
  outdir: "dist/host",
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  splitting: true,
  chunkNames: "chunk-[hash]",
  packages: "external",
  sourcemap: true,
  metafile: true,
});
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const undeclared = new Set();
for (const output of Object.values(host.metafile.outputs)) for (const dependency of output.imports) {
  if (!dependency.external || isBuiltin(dependency.path)) continue;
  const name = dependency.path.split("/").slice(0, dependency.path.startsWith("@") ? 2 : 1).join("/");
  if (!Object.hasOwn(manifest.dependencies, name)) undeclared.add(name);
}
if (undeclared.size) throw new Error(`Undeclared host runtime dependencies: ${[...undeclared].join(", ")}`);
// The relay can be copied to a plain Node server without installing Pi or npm dependencies.
await build({
  absWorkingDir: root,
  entryPoints: ["src/host/relay-cli.ts"],
  outfile: "dist/relay/pi-desk-relay.js",
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
});
if (existsSync(resolve(root, "index.html"))) {
  const { build: buildClient } = await import("vite");
  await buildClient({ root, build: { outDir: "dist/client", emptyOutDir: true } });
}
// The account authority is a separate deployment from the opaque routing broker.
await build({
  absWorkingDir: root,
  entryPoints: ["src/account/cli.ts"],
  outfile: "dist/account/pi-desk-account.js",
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
