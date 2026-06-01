# pi-codex-transport

Pi extension for Codex transport diagnostics and SSE response-header timeout control.

## What it does

- Instruments Codex `/codex/responses` fetch traffic and Codex WebSocket traffic.
- Extends Codex SSE response-header timeout handling beyond Pi's built-in 10s timeout.
- Writes local NDJSON diagnostics and a latest summary for troubleshooting provider/session issues.

## Commands

- `/codex-transport status` — show enabled state, timeout config, log paths, patch stack, and counters.
- `/codex-transport on` / `/codex-transport off` — enable or disable diagnostic instrumentation for this process.
- `/codex-transport mark <note>` — add a user marker to the diagnostic log.
- `/sse-timeout status` — show current timeout state.
- `/sse-timeout set <ms>` or `/sse-timeout <ms>` — set the Codex SSE response-header timeout in milliseconds.
- `/sse-timeout off` — disable the extension-managed SSE response-header timeout.
- `/sse-timeout on` — restore the default timeout.

Timeout values must be between `0` and Node's safe timer maximum (`2147483647` ms). `0` disables the timeout.

## Environment variables

- `CODEX_TRANSPORT_DISABLE=1` — start with instrumentation disabled.
- `CODEX_TRANSPORT_DIR=/path/to/dir` — override the diagnostic directory.
- `CODEX_TRANSPORT_LOG_RAW_IDS=1` — include raw request/session IDs in logs. Leave unset for hashed summaries.
- `PI_CODEX_SSE_HEADER_TIMEOUT_MS=<ms>` — override the configured SSE response-header timeout. Use `off`, `disable`, or `disabled` to disable it.

## Files and privacy

Default directory: `~/.pi/agent/codex-transport/`

- `events.ndjson` — structured diagnostic events.
- `latest-summary.json` — latest counters/session summary.
- `sse-timeout.json` — persisted timeout setting written by `/sse-timeout`.

Logs are intended to avoid full prompt/output capture. They store hashes, byte/character counts, selected safe response headers, and small metadata summaries. Raw IDs are omitted unless `CODEX_TRANSPORT_LOG_RAW_IDS=1` is set.
