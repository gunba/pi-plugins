import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const npm = [
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find(existsSync);
if (!npm) throw new Error("npm must be installed alongside the selected Node executable");
const invoke = (cwd, args, capture = false) => execFileSync(process.execPath, [npm, ...args],
  { cwd, windowsHide: true, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
const manifests = ["package.json", "pi-desk/package.json"];
const locks = ["package-lock.json", "pi-desk/package-lock.json"];
const stamp = join(root, "node_modules/.pi-ci-dependencies.json");
const json = path => JSON.parse(readFileSync(join(root, path), "utf8"));
const within = path => { const part = relative(root, path); return !isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\"); };

/*
 * npm creates absolute Windows workspace junctions. Reuse requires the same
 * workspace, runner image, Node ABI, npm, locked inputs and installation recipe.
 * A release-version bump alone does not alter the installed dependency tree.
 */
function cacheKey() {
  const npmVersion = invoke(root, ["--version"], true).trim();
  const files = new Set([...manifests, ...locks, ".npmrc", "pi-desk/.npmrc", ".github/ci/dependencies.mjs"]);
  const pending = [...manifests];
  while (pending.length) {
    const path = pending.pop(), pkg = json(path);
    for (const spec of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].flatMap(group => Object.values(group ?? {}))) {
      if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
      const directory = resolve(root, dirname(path), spec.slice(5));
      if (!within(directory)) throw new Error("Local CI dependencies must remain in the checkout");
      const manifest = relative(root, join(directory, "package.json")).replaceAll("\\", "/");
      if (!files.has(manifest)) { files.add(manifest); pending.push(manifest); }
      files.add(relative(root, join(directory, ".npmrc")).replaceAll("\\", "/"));
    }
  }
  // npm workspaces are links rather than copied packages, but their manifests
  // can contain installation scripts and must participate in invalidation.
  for (const lock of locks) for (const info of Object.values(json(lock).packages ?? {})) {
    if (!info.link) continue;
    const directory = resolve(root, dirname(lock), info.resolved);
    if (!within(directory)) throw new Error("A workspace link escapes the checkout");
    files.add(relative(root, join(directory, "package.json")).replaceAll("\\", "/"));
    files.add(relative(root, join(directory, ".npmrc")).replaceAll("\\", "/"));
  }
  const hash = createHash("sha256").update(JSON.stringify([
    1, process.platform, process.arch, process.versions.modules, npmVersion,
    process.env.ImageOS ?? "", process.env.ImageVersion ?? "", realpathSync(root),
  ]));
  for (const path of [...files].sort()) {
    let data;
    if (!existsSync(join(root, path))) data = Buffer.from("<absent>");
    else if ([...manifests, ...locks].includes(path)) {
      const value = json(path);
      delete value.version;
      if (value.packages?.[""]) delete value.packages[""].version;
      data = Buffer.from(JSON.stringify(value));
    } else data = readFileSync(join(root, path));
    hash.update(JSON.stringify([path, data.length])).update(data);
  }
  return `ci-tree-v1-${process.platform}-${process.arch}-node${process.versions.modules}-${hash.digest("hex")}`;
}

function verify(key) {
  const saved = JSON.parse(readFileSync(stamp, "utf8"));
  if (saved.format !== 1 || saved.key !== key) throw new Error("Installed dependency cache is incomplete or belongs to different inputs");
  for (const lock of locks) for (const [path, info] of Object.entries(json(lock).packages ?? {})) {
    if (!info.link) continue;
    const installed = join(root, dirname(lock), path), target = resolve(root, dirname(lock), info.resolved);
    if (realpathSync(installed) !== realpathSync(target)) throw new Error("Cached workspace junction points outside this checkout");
  }
  for (const manifest of manifests) {
    const pkg = json(manifest), installed = json(join(dirname(manifest), "node_modules/@earendil-works/pi-coding-agent/package.json"));
    const expected = pkg.dependencies?.["@earendil-works/pi-coding-agent"] ?? pkg.devDependencies?.["@earendil-works/pi-coding-agent"];
    if (installed.version !== expected) throw new Error("Cached SDK does not match the pinned package");
  }
  for (const file of ["node_modules/typescript/lib/tsc.js", "pi-desk/node_modules/typescript/lib/tsc.js", "pi-desk/node_modules/esbuild/bin/esbuild"]) {
    if (!existsSync(join(root, file))) throw new Error("Cached build tools are incomplete");
  }
  // A child releases the native DLL before a later cold installation can run.
  execFileSync(process.execPath, ["-e", "require('keytar')"],
    { cwd: join(root, "pi-desk"), windowsHide: true, stdio: "inherit" });
}

const command = process.argv[2];
if (command === "key") console.log(cacheKey());
else if (command === "npm-cache") console.log(invoke(root, ["config", "get", "cache"], true).trim());
else if (command === "install") {
  const key = cacheKey();
  invoke(root, ["ci"]);
  invoke(root, ["--prefix", "pi-desk", "ci", "--ignore-scripts"]);
  invoke(root, ["--prefix", "pi-desk", "rebuild", "keytar"]);
  writeFileSync(stamp, JSON.stringify({ format: 1, key }) + "\n");
  verify(key);
} else if (command === "verify") {
  verify(cacheKey());
  console.log("Verified exact-input installed dependency cache");
} else throw new Error("Usage: dependencies.mjs <key|npm-cache|install|verify>");
