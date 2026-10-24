import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const CODEX_RELEASE_URL = "https://api.github.com/repos/openai/codex/releases/latest";
export const VERSION_CACHE_MS = 60 * 60 * 1000;
const inFlight = new Map<string, Promise<ResolvedVersion>>();

export interface ResolvedVersion {
  version: string;
  source: "release" | "cache" | "stale-cache";
}

export function codexVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("Codex version must be a release version such as 0.164.0");
  }
  return value;
}

/** Resolve the public release without sending account headers to GitHub. */
export async function latestCodexVersion(
  directory: string, fetcher: typeof fetch = globalThis.fetch, now = Date.now(),
): Promise<ResolvedVersion> {
  const path = join(directory, "latest-version.json");
  let cached: { version: string; checkedAt: number } | undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const version = codexVersion(value.version);
    if (Number.isFinite(value.checkedAt)) cached = { version, checkedAt: value.checkedAt };
  } catch { /* A missing or invalid cache must be refreshed. */ }
  if (cached && now >= cached.checkedAt && now - cached.checkedAt < VERSION_CACHE_MS) {
    return { version: cached.version, source: "cache" };
  }
  const pending = inFlight.get(path);
  if (pending) return pending;
  const refresh = (async (): Promise<ResolvedVersion> => {
    let version: string;
    try {
      const response = await fetcher(CODEX_RELEASE_URL, {
        headers: { accept: "application/vnd.github+json", "user-agent": "pi-codex-wire" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const release = await response.json() as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
      if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string"
        || !/^rust-v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error("Invalid stable Codex release");
      version = codexVersion(release.tag_name.slice(6));
    } catch (error) {
      if (cached) return { version: cached.version, source: "stale-cache" };
      throw new Error(`Cannot resolve the current Codex release; no inference was sent: ${error instanceof Error ? error.message : "lookup failed"}`);
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version, checkedAt: now }) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } catch { /* The verified version remains usable if this host cannot persist its cache. */ }
    finally { try { rmSync(temporary, { force: true }); } catch { /* Cache cleanup cannot invalidate a verified release. */ } }
    return { version, source: "release" };
  })();
  inFlight.set(path, refresh);
  try { return await refresh; }
  finally { if (inFlight.get(path) === refresh) inFlight.delete(path); }
}

/** Saved OS/terminal profiles must not pin the advertised core version. */
export function versionedUserAgent(value: string | undefined, version: string): string | undefined {
  return value?.replace(/\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?= )/, `/${codexVersion(version)}`);
}
