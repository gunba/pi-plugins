export type Compression = "none" | "zstd";

/** Codex 0.147.0: features/src/lib.rs:1084-1087; core/src/client.rs:1378-1388. */
export function requestCompression(enabled: boolean, provider: string, url: string, headers: Headers): Compression {
  const endpoint = new URL(url);
  const codexBackend = endpoint.origin === "https://chatgpt.com" && endpoint.pathname === "/backend-api/codex/responses";
  const codexAuth = headers.get("authorization")?.startsWith("Bearer ") && !!headers.get("chatgpt-account-id");
  return enabled && provider === "openai-codex" && codexBackend && codexAuth ? "zstd" : "none";
}
