export type Compression = "none" | "zstd";

/** Codex 0.153.4: core/src/client.rs uses_codex_backend. */
function isCodexBackend(provider: string, url: string, headers: Headers): boolean {
  const endpoint = new URL(url);
  const codexBackend = endpoint.origin === "https://chatgpt.com" && endpoint.pathname === "/backend-api/codex/responses";
  const codexAuth = headers.get("authorization")?.startsWith("Bearer ") && !!headers.get("chatgpt-account-id");
  return provider === "openai-codex" && codexBackend && !!codexAuth;
}

export function requestCompression(enabled: boolean, provider: string, url: string, headers: Headers): Compression {
  return enabled && isCodexBackend(provider, url, headers) ? "zstd" : "none";
}

/** Native build_routing_hint_header: only model and explicitly selected tier. */
export function requestRoutingHint(provider: string, url: string, headers: Headers, model: string, tier?: unknown): string | undefined {
  if (!isCodexBackend(provider, url, headers)) return;
  const hint = `model=${model}${typeof tier === "string" ? `;tier=${tier}` : ""}`;
  if (/^[\t\x20-\x7e]*$/.test(hint)) return hint;
}
