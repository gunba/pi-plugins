import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
rmSync(resolve(root, "dist/host"), { recursive: true, force: true });
const host = await build({
  absWorkingDir: root,
  entryPoints: ["src/host/cli.ts", "src/host/managed.ts", "src/host/manage-cli.ts", "src/host/worker.ts", "src/host/catalog-worker.ts", "src/host/efficiency-worker.ts", "src/host/search-worker.ts"],
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
// pi-watch's engine, bundled into the host, starts each command watch's runner from runner.mjs beside its own module,
// which is now a chunk in dist/host.
copyFileSync(resolve(root, "../pi-watch/runner.mjs"), resolve(root, "dist/host/runner.mjs"));
await build({
  absWorkingDir: root,
  entryPoints: { "gmail-send": "manage/gmail-send.mjs" },
  outdir: "dist/manage",
  platform: "node",
  target: "node22",
  format: "esm",
  bundle: true,
  packages: "external",
});
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
  // The scripts that draw Office files in Work. They run inside the sandboxed page, which loads nothing itself, so the
  // app fetches one and writes it into the page (client/office-pages.tsx). Each is named by a hash of its content,
  // which the app is built with: the name lets it be cached, and Work keeps drawings by it, so they are drawn again
  // only when the drawing changes, not with every Desk release.
  const frames = {};
  for (const kind of ["docx", "pptx", "xlsx"]) {
    const { outputFiles: [script] } = await build({
      absWorkingDir: root,
      entryPoints: [`src/office-frame/${kind}.ts`],
      write: false,
      outfile: `office-${kind}.js`,
      bundle: true,
      format: "iife",
      minify: true,
      target: "es2022",
      legalComments: "eof",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    frames[kind] = { hash: createHash("sha256").update(script.contents).digest("hex").slice(0, 16), contents: script.contents };
  }
  const { build: buildClient } = await import("vite");
  await buildClient({ root, build: { outDir: "dist/client", emptyOutDir: true },
    define: { __OFFICE_FRAMES__: JSON.stringify(Object.fromEntries(Object.entries(frames).map(([kind, frame]) => [kind, frame.hash]))) } });
  for (const [kind, frame] of Object.entries(frames)) writeFileSync(resolve(root, `dist/client/assets/office-${kind}-${frame.hash}.js`), frame.contents);
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
