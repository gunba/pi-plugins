import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_RELEASE_URL, VERSION_CACHE_MS, latestCodexVersion, versionedUserAgent } from "../extensions/version.ts";

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "pi-wire-version-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("release lookup refreshes an expired version and shares a credential-free cached result", async t => {
  const path = directory(t), now = 2 * VERSION_CACHE_MS;
  writeFileSync(join(path, "latest-version.json"), JSON.stringify({ version: "0.159.1", checkedAt: 0 }));
  let requests = 0;
  const fetcher = async (url, init) => {
    requests++;
    assert.equal(url, CODEX_RELEASE_URL);
    assert.deepEqual(Object.keys(init.headers).sort(), ["accept", "user-agent"]);
    await new Promise(resolve => setImmediate(resolve));
    return Response.json({ tag_name: "rust-v0.164.0", draft: false, prerelease: false });
  };
  const results = await Promise.all([latestCodexVersion(path, fetcher, now), latestCodexVersion(path, fetcher, now)]);
  assert.deepEqual(results, [{ version: "0.164.0", source: "release" }, { version: "0.164.0", source: "release" }]);
  assert.equal(requests, 1);
  assert.deepEqual(await latestCodexVersion(path, fetcher, now + 1), { version: "0.164.0", source: "cache" });
  assert.equal(requests, 1);
  assert.equal(JSON.parse(readFileSync(join(path, "latest-version.json"))).version, "0.164.0");
});

test("failed lookup uses only a verified cache and never invents an old pinned version", async t => {
  const path = directory(t), fetcher = async () => { throw new Error("offline"); };
  await assert.rejects(latestCodexVersion(path, fetcher), /no inference was sent/);
  writeFileSync(join(path, "latest-version.json"), JSON.stringify({ version: "0.163.0", checkedAt: 0 }));
  assert.deepEqual(await latestCodexVersion(path, fetcher), { version: "0.163.0", source: "stale-cache" });
});

test("invalid release data cannot become a wire version", async t => {
  const path = directory(t);
  for (const tag_name of ["rust-v0.164.0\r\nInjected: yes", "rust-v0.165.0-alpha.1", "other-v1.0.0"]) {
    await assert.rejects(latestCodexVersion(path, async () => Response.json({ tag_name, draft: false, prerelease: false })), /Invalid stable Codex release/);
  }
});

test("saved terminal and OS profiles follow the current core version", () => {
  assert.equal(versionedUserAgent("Codex Desktop/0.159.1 (Windows 10; x86_64) terminal (Codex Desktop; 26.903.61454)", "0.164.0"),
    "Codex Desktop/0.164.0 (Windows 10; x86_64) terminal (Codex Desktop; 26.903.61454)");
});
