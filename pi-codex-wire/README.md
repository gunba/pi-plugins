# Pi Codex Wire

An opt-in Pi transport plugin for comparing subscription consumption with Codex-compatible requests. Pi retains its prompts, tools, agent loop and session interface.

Protocol reference: **Codex CLI 0.147.0**, commit [`be6e8eac029b183056b7e4402879f15d2c85f61b`](https://github.com/openai/codex/tree/be6e8eac029b183056b7e4402879f15d2c85f61b). Tested against Pi **0.84.3** and Node **22.22.3**.

## Start a test session

From this directory:

```sh
npm ci --ignore-scripts
pi -e ./extensions/index.ts --codex-wire codex --model openai-codex/gpt-6-astra --thinking medium
```

This package is separate from the parent repository's auto-loaded extension manifest. Loading it without `--codex-wire` leaves it off. Your saved model, authentication and Pi settings are unchanged.

Use `/codex-wire status` to see the mode and diagnostic file. `/codex-wire off` restores the original provider. Mode changes require an idle session and are not saved. The plugin reuses Pi's existing `openai-codex` authentication.

| Mode | Behaviour |
|---|---|
| `off` | Original provider, no experiment logging |
| `stock` | Original provider with request/usage observations |
| `pi` | Codex-compatible transport, Pi originator and User-Agent |
| `codex` | Same transport, Codex CLI originator and User-Agent |

`--codex-wire-transport auto` uses WebSockets with HTTP/SSE fallback. `--codex-wire-transport sse` fixes the experiment to HTTP/SSE. Both identity profiles use the same protocol implementation and Codex version header.

`--codex-wire-compression on` matches Codex 0.147.0's default `enable_request_compression` feature. `off` disables it. Compression applies only to authenticated `openai-codex` requests to the Codex backend over HTTP/SSE; it does not depend on the client identity label. If zstd is selected but unavailable in Node, the request stops before inference. These controls do not change the `stock` provider.

On Windows, the automatic native User-Agent uses `RtlGetVersion` and `GetNativeSystemInfo`, matching the pinned `os_info 3.14.0` dependency. A local PowerShell helper reads these values once; it runs only when an emulation mode is activated. Terminal detection follows the native precedence and sanitization rules, including Windows Terminal and tmux client detection. It does not launch Codex.

For another OS, or to reproduce a captured native profile exactly, supply `--codex-wire-user-agent "codex_cli_rs/0.147.0 (...) terminal"`. It must match the selected originator and pinned version. `--codex-wire-originator` supplies the originator; the native `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` environment variable takes precedence, with invalid header values falling back to `codex_cli_rs`.

## Implemented behaviour

- Changes identity on the actual outgoing request, after Pi's provider has assembled its headers.
- Native root identity lifetime: session ID and prompt-cache key equal the persistent Pi thread ID. Reactivation and resume retain them; new and forked Pi threads receive their own identity. The context window is persisted separately and rotates on context replacement. Canonical `client_metadata` and compatibility headers use the same state.
- A user turn spans its tool round trips. Server-issued turn state is retained within that turn and cleared for the next turn. HTTP headers and WebSocket `response.metadata` events provide the state.
- Persistent WebSocket connection, `generate:false` prewarming, incremental input with `previous_response_id`, metadata-insensitive continuation comparison, and one full-input recovery for a missing previous response.
- SSE fallback and feature-gated zstd request compression at level 3. Changing metadata does not force a full WebSocket input by itself.
- Native model-catalog shaping: supported service tiers, reasoning/verbosity fields, function strictness, and Responses Lite tool/instruction/image transformations.
- Pi's existing serializer and model-event decoder handle tools and reasoning. The adapter locally envelopes WebSocket events as SSE for that decoder; network WebSocket frames remain JSON.

On the first model request, the plugin reads `/codex/models?client_version=0.147.0` using the existing account credential and the selected native identity profile. It keeps only capability fields, not model instructions. Both emulation modes use this same catalog identity deliberately, so the client-label comparison holds capabilities constant.

Snapshots are scoped to endpoint, account and credential. Reversed completion order cannot replace another scope's capabilities. Concurrent lookups have independent cancellation; the first successful result freezes that scope, and returned metadata is detached from the cache. Aborted or failed requests do not publish snapshots. The cache retains up to 16 scopes across mode switches. A missing model or catalog failure stops the request before inference.

## Controlled comparison

First compare **`pi` versus `codex`**. This tests client identity while keeping the transport implementation constant. Compare **`stock` versus `pi`** separately to test implementation effects.

1. Pause other use of the shared allowance, including other Pi sessions, native Codex, Work and background tools. Keep the account, model, reasoning, transport, tools and workload constant.
2. Start each run with fresh conversation history. Use an identical read-only task or fixed fixture. Avoid workloads that change files between runs.
3. Read the same allowance window from the account usage display. Record its **used** percentage and a stable reset label:

   ```text
   /codex-wire mark 12.3 5h:2026-09-07T12:00
   ```

4. Submit the task. After Pi settles and the allowance display updates, record another mark with the same reset label.
5. Repeat in alternating order: `pi`, `codex`, `codex`, `pi`. Keep cold-start and warm-context measurements separate. Use enough repeated work to exceed the allowance display's rounding resolution; agree a budget before doing so.
6. Summarize the diagnostic files locally:

   ```sh
   node report.mjs path/to/pi-run.jsonl path/to/codex-run.jsonl
   ```

The report separates uncached input, cached input, output, reasoning, wire attempts and allowance percentage points. It flags reset changes, failed requests, missing coverage and transport fallback. It does not treat API dollar estimates as subscription accounting or count response usage twice.

A repeatable difference between the identity profiles supports **client-correlated treatment**. It does not establish deliberate discrimination: routing, account experiments, backend bugs and rounding remain alternative explanations. A null result cannot rule out treatment keyed to another client signal.

## Diagnostics and boundaries

Logs are stored in `~/.pi/agent/codex-wire/logs/` (or under `PI_CODING_AGENT_DIR`). They contain counts, capability flags, timestamps, numerical allowance headers and keyed digests. They omit credentials, account IDs, prompts, tool arguments/results and opaque routing tokens. Digest keys remain in memory, so digests are comparable only within one logger lifetime. Remove the log files when no longer needed.

Only requests through this session's registered `openai-codex` provider are covered. Independently launched tools or SDK sessions need their own explicit plugin activation. Proxy environment settings apply to WebSockets; SSE continues through Pi's supplied fetch implementation.

This is protocol emulation, not a claim of byte-for-byte native execution. The transport is pinned to a source version. Native attestation, TLS implementation, native context compaction, and Codex-specific hosted tools remain differences. Unsupported tool namespaces fail explicitly. The model-visible Pi prompt and tools are deliberately retained so identity comparisons hold the workload constant. New native protocol features require a source review and tests before adoption.

No inference or allowance-consuming comparison is run by installation or activation. A user prompt initiates requests.

## Verify locally

```sh
npm test
```

The tests use local HTTP/WebSocket servers and fake credentials, plus Pi's actual serializer/parser. They cover native field projections, turn isolation, continuation, prewarm, fallback, cancellation, catalog failures, tool calls, privacy and report accounting.

Source map:

- `identity.ts`: `login/src/auth/default_client.rs`, `terminal-detection/src/lib.rs`; `native-os-info.ps1` follows the Windows APIs in the pinned `os_info 3.14.0` dependency.
- `protocol.ts`: `core/src/session/session.rs`, `core/src/responses_metadata.rs`, `codex-api/src/requests/headers.rs`.
- `compression.ts`: `features/src/lib.rs`, `core/src/client.rs`.
- `transport.ts`: `core/src/client.rs`, `codex-api/src/endpoint/responses_websocket.rs`, `codex-api/src/sse/responses.rs`.
- `model-shape.ts`: `core/src/client_common.rs`, `tools/src/tool_spec.rs`, `protocol/src/openai_models.rs`.
- `catalog.ts`: `codex-api/src/endpoint/models.rs`.

All reference paths are under the pinned repository's `codex-rs/` directory. Model instructions are not copied from that repository.
