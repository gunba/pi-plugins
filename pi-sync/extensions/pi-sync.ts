import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExecResult, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const START_MARKER = "# >>> pi-sync managed ignores";
const END_MARKER = "# <<< pi-sync managed ignores";
const DEFAULT_BRANCH = "main";
const GIT_TIMEOUT_MS = 60_000;
const UPDATE_TIMEOUT_MS = 180_000;

const MANAGED_GITIGNORE_LINES = [
  START_MARKER,
  "",
  "# Local runtime state",
  "agent/tmp/",
  "agent/sessions/",
  "agent/session-status/",
  "agent/subagents/*/",
  "agent/intercom/",
  "agent/scheduler/",
  "subagent-schedules/",
  "agent/trust.json",
  "",
  "# Package install checkouts and dependency caches",
  "agent/npm/",
  "agent/git/",
  "agent/clones/",
  "agent/backups/",
  "",
  "# Generated databases and caches",
  "context-mode/",
  "agent/context-mode/",
  "agent/pi-web/",
  "agent/pi-web.sqlite*",
  "agent/mcp-cache.json",
  "agent/mcp-onboarding.json",
  "agent/run-history.jsonl",
  "agent/codex-usage/",
  "agent/codex-transport/",
  "agent/context-guard/",
  "agent/pi-fixes/",
  "agent/pi-usage/",
  "agent/memedit/",
  "agent/pi-browser/",
  "",
  "# Local binaries",
  "agent/bin/fd",
  "",
  "# Local auth material",
  "agent/auth.json",
  "agent/mcp-oauth/",
  "web-search.json",
  "",
  "# OS and editor noise",
  "__pycache__/",
  "*.pyc",
  ".DS_Store",
  "Thumbs.db",
  "*.swp",
  "*.tmp",
  "",
  END_MARKER,
  "",
];

type NotifyType = "info" | "warning" | "error";

type ParsedArgs = {
  action: string;
  rest: string;
};

function piRoot(): string {
  return dirname(getAgentDir());
}

function parseArgs(args: string): ParsedArgs {
  const trimmed = args.trim();
  if (!trimmed) return { action: "status", rest: "" };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  return { action: (match?.[1] ?? "status").toLowerCase(), rest: (match?.[2] ?? "").trim() };
}

function notify(ctx: ExtensionCommandContext, message: string, type: NotifyType = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else console.log(message);
}

function trimOutput(value: string, maxLength = 1_200): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}

function execOutput(result: ExecResult): string {
  return trimOutput([result.stdout, result.stderr].filter((part) => part.trim().length > 0).join("\n"));
}

async function git(pi: ExtensionAPI, root: string, args: string[], allowFailure = false, timeout = GIT_TIMEOUT_MS): Promise<ExecResult> {
  const result = await pi.exec("git", args, { cwd: root, timeout });
  if (!allowFailure && result.code !== 0) {
    const output = execOutput(result);
    throw new Error(`git ${args.join(" ")} failed${output ? `\n${output}` : ""}`);
  }
  return result;
}

async function piUpdateExtensions(pi: ExtensionAPI): Promise<ExecResult> {
  return pi.exec("pi", ["update", "--extensions"], { timeout: UPDATE_TIMEOUT_MS });
}

function ensureManagedGitignore(root: string): boolean {
  const path = join(root, ".gitignore");
  const block = MANAGED_GITIGNORE_LINES.join("\n");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  let next: string;

  if (existing.includes(START_MARKER) && existing.includes(END_MARKER)) {
    const pattern = new RegExp(`${escapeRegExp(START_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}\\n?`);
    next = existing.replace(pattern, block);
  } else {
    next = `${existing.replace(/\s*$/, "")}\n\n${block}`.replace(/^\n+/, "");
  }

  if (next === existing) return false;
  writeFileSync(path, next, "utf8");
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultCommitMessage(): string {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  return `Sync Pi setup ${timestamp}`;
}

function isRepo(root: string): boolean {
  return existsSync(join(root, ".git"));
}

async function ensureRepo(pi: ExtensionAPI, root: string): Promise<void> {
  if (isRepo(root)) return;
  throw new Error(`Pi setup is not a git repo yet. Run /pi-sync init <private-repo-url> first.\nRoot: ${root}`);
}

async function initRepo(pi: ExtensionAPI, root: string): Promise<void> {
  mkdirSync(root, { recursive: true });
  if (isRepo(root)) return;

  const init = await git(pi, root, ["init", "-b", DEFAULT_BRANCH], true);
  if (init.code === 0) return;

  await git(pi, root, ["init"]);
  await git(pi, root, ["checkout", "-B", DEFAULT_BRANCH]);
}

async function getOrigin(pi: ExtensionAPI, root: string): Promise<string | undefined> {
  const result = await git(pi, root, ["remote", "get-url", "origin"], true);
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

async function setOrigin(pi: ExtensionAPI, root: string, remote: string): Promise<void> {
  const existing = await getOrigin(pi, root);
  if (existing) await git(pi, root, ["remote", "set-url", "origin", remote]);
  else await git(pi, root, ["remote", "add", "origin", remote]);
}

async function currentBranch(pi: ExtensionAPI, root: string): Promise<string> {
  const result = await git(pi, root, ["branch", "--show-current"], true);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : DEFAULT_BRANCH;
}

async function hasUpstream(pi: ExtensionAPI, root: string): Promise<boolean> {
  const result = await git(pi, root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], true);
  return result.code === 0 && result.stdout.trim().length > 0;
}

async function remoteBranchExists(pi: ExtensionAPI, root: string, branch: string): Promise<boolean> {
  const result = await git(pi, root, ["rev-parse", "--verify", "--quiet", `origin/${branch}`], true);
  return result.code === 0;
}

async function hasHead(pi: ExtensionAPI, root: string): Promise<boolean> {
  const result = await git(pi, root, ["rev-parse", "--verify", "HEAD"], true);
  return result.code === 0;
}

async function remoteTrackedFiles(pi: ExtensionAPI, root: string, ref: string): Promise<string[]> {
  const result = await git(pi, root, ["ls-tree", "-r", "--name-only", ref]);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(".git/"));
}

function bootstrapBackupDir(root: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(root, "agent", "backups", `pi-sync-bootstrap-${stamp}`);
}

function backupExistingPaths(root: string, relativePaths: string[]): string | undefined {
  const backupRoot = bootstrapBackupDir(root);
  let count = 0;

  for (const relativePath of relativePaths) {
    const source = join(root, relativePath);
    if (!existsSync(source)) continue;

    const target = join(backupRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
    count += 1;
  }

  return count > 0 ? backupRoot : undefined;
}

async function commitLocalChanges(pi: ExtensionAPI, root: string, message: string): Promise<boolean> {
  await git(pi, root, ["add", "-A"]);
  const diff = await git(pi, root, ["diff", "--cached", "--quiet"], true);
  if (diff.code === 0) return false;
  if (diff.code !== 1) throw new Error(`git diff --cached --quiet failed${execOutput(diff) ? `\n${execOutput(diff)}` : ""}`);
  await git(pi, root, ["commit", "-m", message]);
  return true;
}

async function pushBranch(pi: ExtensionAPI, root: string): Promise<void> {
  const origin = await getOrigin(pi, root);
  if (!origin) throw new Error("No origin remote configured. Run /pi-sync remote <private-repo-url> first.");

  if (await hasUpstream(pi, root)) await git(pi, root, ["push"]);
  else await git(pi, root, ["push", "-u", "origin", "HEAD"]);
}

async function pullFastForward(pi: ExtensionAPI, root: string): Promise<void> {
  const origin = await getOrigin(pi, root);
  if (!origin) throw new Error("No origin remote configured. Run /pi-sync remote <private-repo-url> first.");

  if (await hasUpstream(pi, root)) {
    await git(pi, root, ["pull", "--ff-only"]);
    return;
  }

  const branch = await currentBranch(pi, root);
  await git(pi, root, ["pull", "--ff-only", "origin", branch]);
  await git(pi, root, ["branch", "--set-upstream-to", `origin/${branch}`, branch], true);
}

async function pullRebase(pi: ExtensionAPI, root: string): Promise<void> {
  const origin = await getOrigin(pi, root);
  if (!origin) throw new Error("No origin remote configured. Run /pi-sync remote <private-repo-url> first.");

  if (await hasUpstream(pi, root)) {
    await git(pi, root, ["pull", "--rebase", "--autostash"]);
    return;
  }

  const branch = await currentBranch(pi, root);
  await git(pi, root, ["fetch", "origin"]);
  if (await remoteBranchExists(pi, root, branch)) {
    await git(pi, root, ["pull", "--rebase", "--autostash", "origin", branch]);
    await git(pi, root, ["branch", "--set-upstream-to", `origin/${branch}`, branch], true);
  }
}

async function refreshPackages(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const result = await piUpdateExtensions(pi);
  if (result.code === 0) return;
  const output = execOutput(result);
  notify(ctx, `Pi setup synced, but pi update --extensions failed${output ? `:\n${output}` : "."}`, "warning");
}

async function showStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext, root: string): Promise<void> {
  if (!isRepo(root)) {
    notify(ctx, `Pi setup sync is not initialized.\nRoot: ${root}\nRun /pi-sync init <private-repo-url>.`, "warning");
    return;
  }

  const [status, origin] = await Promise.all([
    git(pi, root, ["status", "--short", "--branch"], true),
    getOrigin(pi, root),
  ]);
  const statusText = status.code === 0 ? status.stdout.trim() || "clean" : execOutput(status) || "status unavailable";
  notify(ctx, `Pi setup sync\nRoot: ${root}\nOrigin: ${origin ?? "not set"}\n${trimOutput(statusText)}`);
}

async function handleInit(pi: ExtensionAPI, ctx: ExtensionCommandContext, root: string, remote: string): Promise<void> {
  await initRepo(pi, root);
  const changedIgnore = ensureManagedGitignore(root);
  if (remote) await setOrigin(pi, root, remote);
  notify(ctx, `Pi setup sync initialized at ${root}${remote ? `\nOrigin: ${remote}` : ""}${changedIgnore ? "\nManaged .gitignore refreshed." : ""}`);
}

async function handlePull(pi: ExtensionAPI, ctx: ExtensionCommandContext, root: string): Promise<void> {
  await ensureRepo(pi, root);
  ensureManagedGitignore(root);
  await pullFastForward(pi, root);
  await refreshPackages(pi, ctx);
  notify(ctx, "Pi setup pulled. Run /reload or restart Pi to load changed resources.");
}

async function handlePush(pi: ExtensionAPI, ctx: ExtensionCommandContext, root: string, message: string): Promise<void> {
  await ensureRepo(pi, root);
  const changedIgnore = ensureManagedGitignore(root);
  const committed = await commitLocalChanges(pi, root, message || defaultCommitMessage());
  await pushBranch(pi, root);
  notify(ctx, `Pi setup pushed.${committed ? "" : " No local changes to commit."}${changedIgnore && !committed ? " Managed .gitignore refreshed." : ""}`);
}

async function handleSync(pi: ExtensionAPI, ctx: ExtensionCommandContext, root: string, message: string): Promise<void> {
  await ensureRepo(pi, root);
  ensureManagedGitignore(root);
  const committed = await commitLocalChanges(pi, root, message || defaultCommitMessage());
  await pullRebase(pi, root);
  await pushBranch(pi, root);
  await refreshPackages(pi, ctx);
  notify(ctx, `Pi setup synced.${committed ? "" : " No local changes to commit."} Run /reload or restart Pi to load changed resources.`);
}

async function handleRemote(pi: ExtensionAPI, ctx: ExtensionCommandContext, root: string, remote: string): Promise<void> {
  if (!remote) throw new Error("Usage: /pi-sync remote <private-repo-url>");
  await initRepo(pi, root);
  ensureManagedGitignore(root);
  await setOrigin(pi, root, remote);
  notify(ctx, `Pi setup sync origin set to ${remote}`);
}

async function handleBootstrap(pi: ExtensionAPI, ctx: ExtensionCommandContext, root: string, remote: string): Promise<void> {
  if (!remote) throw new Error("Usage: /pi-sync bootstrap <private-repo-url>");

  await initRepo(pi, root);
  await setOrigin(pi, root, remote);

  if (await hasHead(pi, root)) {
    await pullFastForward(pi, root);
    await refreshPackages(pi, ctx);
    notify(ctx, "Pi setup bootstrap complete. Existing repo fast-forwarded; run /reload or restart Pi.");
    return;
  }

  await git(pi, root, ["fetch", "origin"]);
  const branch = DEFAULT_BRANCH;
  const ref = `origin/${branch}`;
  if (!(await remoteBranchExists(pi, root, branch))) {
    throw new Error(`Remote branch ${ref} was not found.`);
  }

  const trackedFiles = await remoteTrackedFiles(pi, root, ref);
  const backupDir = backupExistingPaths(root, trackedFiles);
  await git(pi, root, ["checkout", "-B", branch, ref]);
  await git(pi, root, ["branch", "--set-upstream-to", ref, branch], true);
  await refreshPackages(pi, ctx);

  notify(ctx, `Pi setup bootstrap complete.${backupDir ? ` Previous local files backed up to ${backupDir}.` : ""} Run /reload or restart Pi.`);
}

function helpText(root: string): string {
  return [
    "Pi setup sync commands:",
    "  /pi-sync status",
    "  /pi-sync init [private-repo-url]",
    "  /pi-sync bootstrap <private-repo-url>",
    "  /pi-sync pull",
    "  /pi-sync push [commit message]",
    "  /pi-sync sync [commit message]",
    "  /pi-sync remote <private-repo-url>",
    "  /pi-sync ignore",
    `Root: ${root}`,
  ].join("\n");
}

async function run(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
  const root = piRoot();
  const { action, rest } = parseArgs(args);

  switch (action) {
    case "status":
      await showStatus(pi, ctx, root);
      return;
    case "init":
      await handleInit(pi, ctx, root, rest);
      return;
    case "bootstrap":
      await handleBootstrap(pi, ctx, root, rest);
      return;
    case "pull":
    case "update":
      await handlePull(pi, ctx, root);
      return;
    case "push":
      await handlePush(pi, ctx, root, rest);
      return;
    case "sync":
      await handleSync(pi, ctx, root, rest);
      return;
    case "remote":
      await handleRemote(pi, ctx, root, rest);
      return;
    case "ignore":
      mkdirSync(root, { recursive: true });
      notify(ctx, ensureManagedGitignore(root) ? "Pi setup .gitignore refreshed." : "Pi setup .gitignore already current.");
      return;
    case "help":
    case "--help":
    case "-h":
      notify(ctx, helpText(root));
      return;
    default:
      throw new Error(`Unknown pi-sync action: ${action}\n\n${helpText(root)}`);
  }
}

export default function piSync(pi: ExtensionAPI): void {
  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    try {
      await run(pi, ctx, args);
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : String(error), "error");
    }
  };

  pi.registerCommand("pi-sync", {
    description: "Sync ~/.pi setup through a private git repository",
    handler,
  });

  pi.registerCommand("pisync", {
    description: "Alias for /pi-sync",
    handler,
  });
}
