import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const npm = [
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find(existsSync);
if (!npm) throw new Error("npm must be installed alongside the selected Node executable");
// The selected CLI reports this package version; reading it avoids bootstrapping npm on cache hits.
const npmVersion = JSON.parse(readFileSync(resolve(dirname(npm), "../package.json"), "utf8")).version;
if (typeof npmVersion !== "string") throw new Error("npm package version is missing");
const invoke = (args, capture = false) => execFileSync(process.execPath, [npm, ...args],
  { cwd: root, windowsHide: true, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
const manifests = ["package.json", "pi-desk/package.json"];
const locks = ["package-lock.json", "pi-desk/package-lock.json"];
const stamp = join(root, "node_modules/.pi-ci-dependencies.json");
const json = path => JSON.parse(readFileSync(join(root, path), "utf8"));
const within = path => { const part = relative(root, path); return !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep); };

function workspaceLinks() {
  const result = [];
  for (const lock of locks) for (const [path, info] of Object.entries(json(lock).packages ?? {})) {
    if (!info.link) continue;
    const installed = resolve(root, dirname(lock), path), target = resolve(root, dirname(lock), info.resolved);
    if (!within(installed) || !within(target)) throw new Error("A workspace link escapes the checkout");
    result.push({ installed, target });
  }
  return result;
}

/*
 * Absolute Windows junctions require the same workspace. Native dependencies
 * require the same runner image, Node, npm, locked inputs and install recipe.
 * Local install hooks or copied file dependencies can have additional inputs,
 * so those projects always use a fresh installation rather than a cached tree.
 */
function inputs() {
  const files = new Set([...manifests, ...locks, ".npmrc", "pi-desk/.npmrc", ".github/ci/dependencies.mjs"]);
  for (const { target } of workspaceLinks()) {
    files.add(relative(root, join(target, "package.json")).split(sep).join("/"));
    files.add(relative(root, join(target, ".npmrc")).split(sep).join("/"));
  }
  let cacheable = true;
  for (const path of [...files].filter(path => path.endsWith("package.json"))) {
    const pkg = json(path);
    if (Object.keys(pkg.scripts ?? {}).some(name => /^(?:pre|post)?(?:install|prepare|publish)(?:Only)?$/.test(name))) cacheable = false;
    if ([pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some(group =>
      Object.values(group ?? {}).some(spec => typeof spec === "string" && spec.startsWith("file:")))) cacheable = false;
  }
  const hash = createHash("sha256").update(JSON.stringify([
    2, process.platform, process.arch, process.versions.node, npmVersion,
    process.env.ImageOS ?? "", process.env.ImageVersion ?? "", realpathSync(root),
  ]));
  for (const path of [...files].sort()) {
    let data;
    if (!existsSync(join(root, path))) data = Buffer.from("<absent>");
    else if (cacheable && [...manifests, ...locks].includes(path)) {
      const value = json(path);
      delete value.version;
      if (value.packages?.[""]) delete value.packages[""].version;
      data = Buffer.from(JSON.stringify(value));
    } else data = readFileSync(join(root, path));
    hash.update(JSON.stringify([path, data.length])).update(data);
  }
  return { key: `ci-tree-v2-${process.platform}-${process.arch}-node${process.versions.modules}-${hash.digest("hex")}`, cacheable };
}

function archivePaths() {
  if (!process.env.RUNNER_TEMP) throw new Error("RUNNER_TEMP is required for Windows CI caching");
  return ["root", "desk"].map(name => join(process.env.RUNNER_TEMP, "ci-" + name + "-dependencies.tar"));
}
function cachePaths() {
  return process.platform === "win32" ? archivePaths().join("\n") : [join(root, "node_modules"), join(root, "pi-desk/node_modules")].join("\n");
}
function nativeTar(args) {
  return new Promise((accept, reject) => {
    const child = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), args,
      { cwd: root, windowsHide: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", code => code === 0 ? accept() : reject(new Error("Native cache archive operation exited " + code)));
  });
}
function restoreWorkspaceLinks() {
  for (const { installed, target } of workspaceLinks()) {
    try {
      if (!lstatSync(installed).isSymbolicLink() || realpathSync(installed) !== realpathSync(target))
        throw new Error("A cached workspace link points outside this checkout");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(dirname(installed), { recursive: true });
      symlinkSync(target, installed, process.platform === "win32" ? "junction" : "dir");
    }
  }
}
function verify(key) {
  const saved = JSON.parse(readFileSync(stamp, "utf8"));
  if (saved.format !== 2 || saved.key !== key) throw new Error("Installed dependency cache is incomplete or belongs to different inputs");
  for (const { installed, target } of workspaceLinks())
    if (realpathSync(installed) !== realpathSync(target)) throw new Error("Cached workspace junction is invalid");
  for (const manifest of manifests) {
    const pkg = json(manifest), installed = json(join(dirname(manifest), "node_modules/@earendil-works/pi-coding-agent/package.json"));
    const expected = pkg.dependencies?.["@earendil-works/pi-coding-agent"] ?? pkg.devDependencies?.["@earendil-works/pi-coding-agent"];
    if (installed.version !== expected) throw new Error("Cached SDK does not match the pinned package");
  }
  for (const file of ["node_modules/typescript/lib/tsc.js", "pi-desk/node_modules/typescript/lib/tsc.js", "pi-desk/node_modules/esbuild/bin/esbuild"])
    if (!existsSync(join(root, file))) throw new Error("Cached build tools are incomplete");
  // Keep the DLL in a child, so no later installation or archive step encounters a parent-held lock.
  execFileSync(process.execPath, ["-e", "require('keytar')"],
    { cwd: join(root, "pi-desk"), windowsHide: true, stdio: "inherit" });
}

// Match release staging: a runner never loads another platform's ONNX binaries.
function pruneForeignBinaries() {
  const bin = join(root, "pi-desk/node_modules/onnxruntime-node/bin");
  if (!existsSync(bin)) return;
  for (const napi of readdirSync(bin, { withFileTypes: true })) {
    if (!napi.isDirectory()) continue;
    for (const platform of readdirSync(join(bin, napi.name), { withFileTypes: true })) {
      const directory = join(bin, napi.name, platform.name);
      if (platform.name !== process.platform) { rmSync(directory, { recursive: true, force: true }); continue; }
      for (const arch of readdirSync(directory)) if (arch !== process.arch)
        rmSync(join(directory, arch), { recursive: true, force: true });
    }
  }
}

const command = process.argv[2];
if (command === "key") console.log(inputs().key);
else if (command === "outputs") {
  if (process.argv[3] && process.versions.node.split(".")[0] !== process.argv[3]) throw new Error("Selected Node has the wrong major version");
  if (process.env.RUNNER_ARCH && process.arch !== process.env.RUNNER_ARCH.toLowerCase()) throw new Error("Selected Node has the wrong architecture");
  console.log("Verified Node " + process.versions.node + " (" + process.arch + ")");
  const { key, cacheable } = inputs();
  appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\ncacheable=${cacheable}\npaths<<CI_DEPENDENCY_PATHS\n${cachePaths()}\nCI_DEPENDENCY_PATHS\n`);
} else if (command === "npm-cache") console.log(invoke(["config", "get", "cache"], true).trim());
else if (command === "install") {
  const { key, cacheable } = inputs();
  invoke(["ci"]);
  invoke(["--prefix", "pi-desk", "ci", "--ignore-scripts"]);
  invoke(["--prefix", "pi-desk", "rebuild", "keytar"]);
  if (cacheable) {
    pruneForeignBinaries();
    writeFileSync(stamp, JSON.stringify({ format: 2, key }) + "\n");
    verify(key);
  }
} else if (command === "restore") {
  if (process.platform === "win32") {
    await Promise.all(archivePaths().map(file => nativeTar(["-xf", file, "-C", root])));
    restoreWorkspaceLinks();
  }
  verify(inputs().key);
  console.log("Verified exact-input installed dependency cache");
} else if (command === "prepare-cache") {
  const { key, cacheable } = inputs();
  if (!cacheable) throw new Error("Project installation hooks require a fresh dependency tree");
  verify(key);
  // Only pristine installed dependencies are saved, before checks can generate source caches.
  for (const path of ["node_modules/.cache", "pi-desk/node_modules/.cache"]) rmSync(join(root, path), { recursive: true, force: true });
  if (process.platform === "win32") {
    // Actions' MSYS tar handles only the outer archives; native tar handles their filesystem entries.
    // Recreate workspace junctions from the current lockfiles rather than archiving absolute links.
    const excludes = workspaceLinks().map(({ installed }) => "--exclude=" + relative(root, installed).split(sep).join("/"));
    // The two independent npm installations occupy disjoint trees and can be extracted concurrently.
    const trees = ["node_modules", "pi-desk/node_modules"];
    await Promise.all(archivePaths().map((file, index) => nativeTar(["-cf", file, "--format=pax", ...excludes, "-C", root, trees[index]])));
  }
} else throw new Error("Usage: dependencies.mjs <key|outputs|npm-cache|install|restore|prepare-cache>");
