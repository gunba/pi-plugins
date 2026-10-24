import { execFile } from "node:child_process";
import type { Workspace } from "./protocol.ts";

/** One git command's trimmed output, or undefined when it fails or runs past the deadline. */
function git(args: string[], cwd: string, timeout: number): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile("git", args, { cwd, timeout, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
  });
}

/**
 * A remote URL without credentials, as native Codex's SanitizedGitUrl keeps it: user names and passwords go, except
 * SSH's conventional `git` user; remote-helper prefixes (`helper::`) and the rest of the address are kept as written.
 */
export function sanitizeRemote(value: string): string | undefined {
  let address = value;
  for (let match = /^([A-Za-z0-9+.-]+)::/.exec(address); match; match = /^([A-Za-z0-9+.-]+)::/.exec(address)) address = address.slice(match[0].length);
  const helper = value.slice(0, value.length - address.length);
  if (helper && /\s/.test(address)) return;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(.*)$/.exec(address);
  if (scheme) {
    const [, protocol, authority, path] = scheme, at = authority!.lastIndexOf("@");
    if (at < 0) return value;
    const userinfo = authority!.slice(0, at), host = authority!.slice(at + 1);
    const keepGit = protocol === "ssh" && userinfo === "git";
    return `${helper}${protocol}://${keepGit ? "git@" : ""}${host}${path}`;
  }
  // SCP style: user@host:path. Only the user goes.
  const colon = address.indexOf(":"), at = address.slice(0, colon < 0 ? address.length : colon).lastIndexOf("@");
  if (at < 0 || address.slice(0, at) === "git") return value;
  return `${helper}${address.slice(at + 1)}`;
}

/** The git workspace a turn runs in, keyed by repository root, as native turn metadata reports it; undefined outside git. */
export async function gitWorkspaces(cwd: string, timeout = 2_000): Promise<Record<string, Workspace> | undefined> {
  const root = await git(["rev-parse", "--show-toplevel"], cwd, timeout);
  if (!root) return;
  const [head, remotes, status] = await Promise.all([git(["rev-parse", "HEAD"], cwd, timeout), git(["remote", "-v"], cwd, timeout),
    git(["status", "--porcelain"], root, timeout)]);
  const urls: Record<string, string> = {};
  for (const line of (remotes ?? "").split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    const url = match && sanitizeRemote(match[2]!);
    if (match && url) urls[match[1]!] = url;
  }
  const workspace: Workspace = {
    ...(Object.keys(urls).length ? { associated_remote_urls: Object.fromEntries(Object.entries(urls).sort(([a], [b]) => a < b ? -1 : 1)) } : {}),
    ...(head ? { latest_git_commit_hash: head } : {}),
    ...(status !== undefined ? { has_changes: status.length > 0 } : {}),
  };
  return Object.keys(workspace).length ? { [root]: workspace } : undefined;
}
