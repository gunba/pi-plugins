# pi-sse-timeout

Pi extension that overrides Pi's hard-coded OpenAI Codex SSE response-header timeout.

## What this changes

Pi `0.76.0` has a hard-coded Codex SSE header timeout of `10_000ms` in the OpenAI Codex provider. That value is separate from `httpIdleTimeoutMs`, so increasing `httpIdleTimeoutMs` does not affect the specific error:

```text
Codex SSE response headers timed out after 10000ms
```

This extension wraps `globalThis.fetch` for only:

```text
https://chatgpt.com/backend-api/codex/responses
```

It suppresses Pi's internal 10s pre-header abort and applies a configurable replacement timeout. It also re-installs itself immediately before provider requests if Pi or another extension has replaced `globalThis.fetch`, so the override remains the outermost fetch wrapper. If the underlying fetch fails after Pi's built-in 10s abort has been suppressed, it returns a synthetic Codex SSE error event so Pi's provider cannot rewrite the failure back to the original `10000ms` error. It does not alter successful prompts or response bodies.

## Install

From this directory:

```bash
pi install /path/to/pi-sse-timeout
```

Or add the extension path to `~/.pi/agent/settings.json` / `.pi/settings.json`:

```json
{
  "extensions": ["/path/to/pi-sse-timeout/extensions/codex-sse-timeout.ts"]
}
```

Restart Pi after installing.

## Configure

Default replacement timeout: `120000ms`.

Set with slash command:

```text
/sse-timeout status
/sse-timeout set 120000
/sse-timeout off
/sse-timeout on
```

Persistent config is written to:

```text
~/.pi/agent/pi-sse-timeout/config.json
```

Environment override:

```bash
PI_CODEX_SSE_HEADER_TIMEOUT_MS=120000 pi
```

## Logs

Operational metadata only is appended to:

```text
~/.pi/agent/pi-sse-timeout/events.ndjson
```

The log includes request sizes, hashed session/cache IDs, timeout suppression events, response-header timing, synthetic error-response events, patch re-install events, and errors. It does not log prompts or response bodies.

## Limitations

This is a runtime shim, not an upstream Pi API. It exists because the Codex SSE header timeout is not currently exposed as a setting.

If Pi's internal 10s timeout fires, the combined provider signal is already aborted. The extension can keep the network request alive until the configured timeout, but cancellation during that extra window may not be as immediate as native provider support would be. The proper upstream fix is a first-class configurable Codex SSE header/first-event timeout.

## Transport note

`transport: "websocket-cached"` can avoid the SSE path when WebSocket succeeds. Current Pi may still fall back to SSE after some WebSocket failures. This extension only changes the SSE path.
