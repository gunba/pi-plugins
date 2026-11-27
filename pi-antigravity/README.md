# Gemini on a Google subscription

Loads [`pi-antigravity-acp-provider`](https://github.com/zacbemis/pi-antigravity-acp-provider), pinned in
`package.json` and followed by the Pi update workflow like the Claude sign-in extension. It adds the
`antigravity-acp/*` models: the Gemini models of the signed-in Google AI plan, run by Google's own Antigravity ACP
server, which the provider downloads from the [ACP registry](https://github.com/agentclientprotocol/registry) on first
use and checks against the registry's digest (about 100 MB to download on Windows and 270 MB on Linux; 815 MB on disk on
Linux). Pi never handles the Google sign-in token: the server keeps it, under
`~/.pi/agent/antigravity-acp-provider/`, and Pi's `auth.json` holds only a marker.

## Signing in

On each computer that should offer Gemini: Desk's **Settings → Accounts & connections → Google Antigravity (ACP) →
Sign in with Google**, or `/login antigravity-acp` in terminal Pi. The first sign-in downloads the server. Sign-ins are
per computer and are not mirrored. Google's sign-in page redirects to the server on `127.0.0.1`, so finish it in a
browser on the same computer; on Linux without a display Desk shows the link and asks for the final redirect address
instead (not available on Windows).

## Behaviour

- Gemini receives Pi's system prompt, history and tools (as `pi_codemode` and other `pi_` tools over a local MCP
  bridge), so Pi's command guard and Desk's change tracking apply as for other models.
- Antigravity also has its own commands and edits, which bypass both. The package runs them unasked by default; here a
  computer without a saved choice asks first (`permissions: "default"` in `config.json` beside the token). Where
  the question cannot be shown, the action is refused. `/antigravity-acp permissions` changes it.
- Outside `yolo`, Antigravity would also ask before each call to Pi's tools; those run unasked here, as Claude's do.
- `/antigravity-acp doctor` shows the server, sign-in, permission mode and any Pi tool the bridge left out;
  `/antigravity-acp quota` shows the plan's remaining allowance.

## Google's terms

Google's Antigravity terms forbid using a consumer sign-in through third-party software, and its staff have said that
wrapping the server in another agent's harness is not permitted. Accounts banned so far, in waves since February 2026,
had sent requests with the sign-in token from other software, used proxies, or rotated several accounts; no ban has been
traced to the unmodified server driven over ACP, but that route is recent. Use one account, sign in only on computers
you use yourself rather than servers in a datacenter, and stop at the first "service has been disabled" or "verify your
account" error. A ban covers Antigravity and Gemini CLI, not the rest of the Google account; one appeal is allowed.
