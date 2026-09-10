# Pi Codex Wire

The always-enabled Codex transport included in `pi-plugins`. Pi retains its prompts, tools, agent loop and session interface.

Protocol reference: **Codex CLI 0.153.4**, commit [`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a). The bundle requires Pi **0.85.1+** and Node **22.19+**.

## Installation and activation

Install or update the main package:

```sh
pi install https://github.com/gunba/pi-plugins
```

The parent manifest loads Wire automatically. Do not register this subdirectory separately. Remove any old standalone Wire registration, then reload Pi. Your saved model and authentication are unchanged. For a checkout whose dependencies were removed, run `npm ci --omit=dev --legacy-peer-deps` at the repository root.

The package installs its Pi serializer dependency explicitly. A native ESM module
loads its public subpaths independently of the extension loader's root-module
aliases, supporting both the bundled CLI and SDK child runtimes.

Codex mode is mandatory on startup, resume, fork and reload. The old mode flag, mode-switch commands and saved `default-mode` setting are no longer used. If activation fails after loading, Codex requests are blocked rather than sent through the original provider.

Use `/codex-wire status` to see the client identity, last request outcome and diagnostic file. `/codex-wire reconnect` creates fresh transport state without disabling Wire. Activation is not itself a successful request. Changes require an idle session. The plugin reuses Pi's existing `openai-codex` authentication.

## CLI and Desktop identities

CLI identity is the initial client selection. `/codex-wire client desktop` selects and saves Desktop identity; `/codex-wire client cli` switches back. `--codex-wire-client cli|desktop` overrides the saved client at startup. Both choices keep Wire enabled and use the same pinned protocol and Codex version header.

The Desktop profile uses originator `Codex Desktop` and the native app-server User-Agent suffix `(Codex Desktop; 26.903.61454)`. The application version was read from the installed official Electron package, rather than its different Windows Store version. `--codex-wire-desktop-version` permits an explicitly selected application version. The native [initialization code](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/initialize_processor.rs) defines the client-name/version suffix. This models Desktop initialization of Wire's pinned **0.153.4** app-server protocol; it does not claim to reproduce the installed Desktop binary's exact core version.

Desktop identity applies to both catalog and inference requests. Switching clients discards the old catalog and connections. Conflicting Desktop originator overrides are rejected. This is request-identity emulation, not the Desktop runtime, its attestation or a guarantee of Desktop allowance treatment.

`--codex-wire-transport auto` uses WebSockets with HTTP/SSE fallback. `--codex-wire-transport sse` fixes the transport to HTTP/SSE.

Full-prompt WebSocket prewarming is **off by default**. `/codex-wire prewarm on|off`
saves the choice; `--codex-wire-prewarm on|off` overrides it at startup. This
controls only the extra `generate:false` request, not Wire, Codex identity,
WebSocket reuse or continuation. Reconnects follow the same setting.

`--codex-wire-compression on` matches Codex 0.153.4's default `enable_request_compression` feature. `off` disables compression, not Wire. Compression applies only to authenticated `openai-codex` requests to the Codex backend over HTTP/SSE. If zstd is selected but unavailable in Node, the request stops before inference.

On Windows, the automatic native User-Agent uses `RtlGetVersion` and `GetNativeSystemInfo`, matching the pinned `os_info 3.14.0` dependency. A local PowerShell helper reads these values once; it runs only when an emulation mode is activated. Terminal detection follows the native precedence and sanitization rules, including Windows Terminal and tmux client detection. It does not launch Codex.

For another OS, or to reproduce a captured native profile exactly, supply `--codex-wire-user-agent "codex_cli_rs/0.153.4 (...) terminal"`. It must match the selected originator and pinned version. `--codex-wire-originator` supplies the originator; the native `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` environment variable takes precedence, with invalid header values falling back to `codex_cli_rs`.

You can save a verified native profile for this machine with
`/codex-wire user-agent codex_cli_rs/0.153.4 (...) terminal`. The profile is stored
under `~/.pi/agent/codex-wire/user-agent` and is used on activation, resume, and
reload. An explicit `--codex-wire-user-agent` overrides the saved profile. This
lets Linux sessions activate Wire without repeating flags. CLI and Desktop User-Agent profiles are saved separately; the current client determines which profile is written.

## Implemented behaviour

- Changes identity on the actual outgoing request, after Pi's provider has assembled its headers.
- Native root identity lifetime: session ID and prompt-cache key equal the persistent Pi thread ID. Reactivation and resume retain them; new and forked Pi threads receive their own identity. The context window is persisted separately and rotates on context replacement. Canonical `client_metadata` and compatibility headers use the same state.
- Inherited provider calls use separate transports keyed by Pi's request `sessionId`. SDK children have independent sockets, continuation, turn state and cache identity. Parent model changes cancel only parent requests. Retired provider copies cannot reopen connections; at most 16 idle auxiliary transports are retained.
- A user turn spans its tool round trips. Server-issued turn state is retained within that turn and cleared for the next turn. HTTP headers and WebSocket `response.metadata` events provide the state.
- Persistent WebSocket connection, optional `generate:false` prewarming on fresh connections, incremental input with `previous_response_id`, metadata-insensitive continuation comparison, and one full-input recovery for a missing previous response.
- Continuation retains completed `response.output_item.done` items when the final event omits them or contains `output: []`, as the live Lite backend does. Items are ordered by output index; incomplete, conflicting or unsupported output falls back to the full request. Content-free `continuation-state` diagnostics record retention and rejection reasons. Smaller network payloads do not establish subscription-allowance savings.
- The server's one-hour WebSocket expiry triggers one internal reconnect when no model output has arrived. A fresh connection follows the selected prewarm setting and the request is replayed. Partial output is not replayed, cancellation still works during recovery, and an exhausted recovery is surfaced rather than retried by Pi's HTTP-fetch loop.
- Native `x-codex-routing-hint` on HTTP requests and WebSocket handshakes, using the final model and explicitly selected service tier.
- SSE fallback and feature-gated zstd request compression at level 3. Changing metadata does not force a full WebSocket input by itself.
- Native model-catalog shaping: supported service tiers, reasoning/verbosity fields, function strictness, and Responses Lite tool/instruction/image transformations. Lite tool and instruction prefixes receive deterministic, thread-scoped UUIDv5 IDs. Effort mapping follows the 0.153.4 rules; parallel calls follow the prompt and are disabled in Lite mode.
- Allowance counters from WebSocket upgrades, stream events and SSE responses are forwarded to `pi-codex-compat` through `pi-codex-wire:allowance`. The event contains only allowlisted counters and plan labels. The footer updates passively, including when the 7-day window is reported as the primary window.
- Pi's existing serializer and model-event decoder handle tools and reasoning. The adapter locally envelopes WebSocket events as SSE for that decoder; network WebSocket frames remain JSON. When history is replayed under a different tool-call type, incompatible optional item IDs are omitted; call/result links and saved messages remain unchanged.

On the first model request, the plugin reads `/codex/models?client_version=0.153.4` using the existing account credential and the selected client identity. It keeps only capability fields, not model instructions.

Snapshots are scoped to endpoint, account and credential. Reversed completion order cannot replace another scope's capabilities. Concurrent lookups have independent cancellation; the first successful result freezes that scope, and returned metadata is detached from the cache. Aborted or failed requests do not publish snapshots. Each activation retains up to 16 catalog scopes. Catalog fetch failures or malformed entries stop the request before inference.

Model lookup follows native Codex: longest matching prefix, then a single simple provider-namespace suffix. If neither matches, the plugin uses Codex 0.153.4's fallback capabilities, displays a warning and records `nativeFallback: true`. It keeps the requested model ID and reasoning effort. The catalog is not an allowlist: a model can accept requests without appearing there. The backend still decides whether the account can use that model.

## Controlled comparison

Compare **CLI versus Desktop** identity with the same Wire transport. This does not compare the full native applications.

1. Pause other use of the shared allowance, including other Pi sessions, native Codex, Work and background tools. Keep the account, model, reasoning, transport, tools and workload constant.
2. Start each run with fresh conversation history. Use an identical read-only task or fixed fixture. Avoid workloads that change files between runs.
3. Read the same allowance window from the account usage display. Record its **used** percentage and a stable reset label:

   ```text
   /codex-wire mark 12.3 5h:2026-09-07T12:00
   ```

4. Submit the task. After Pi settles and the allowance display updates, record another mark with the same reset label.
5. Repeat in alternating order: CLI, Desktop, Desktop, CLI. Keep cold-start and warm-context measurements separate. Use enough repeated work to exceed the allowance display's rounding resolution; agree a budget before doing so.
6. Summarize the diagnostic files locally:

   ```sh
   node report.mjs path/to/cli-run.jsonl path/to/desktop-run.jsonl
   ```

The report separates uncached input, cached input, output, reasoning, wire attempts and allowance percentage points. It flags reset changes, failed requests, missing coverage and transport fallback. It does not treat API dollar estimates as subscription accounting or count response usage twice.

A repeatable difference between the identity profiles supports **client-correlated treatment**. It does not establish deliberate discrimination: routing, account experiments, backend bugs and rounding remain alternative explanations. A null result cannot rule out treatment keyed to another client signal.

## Diagnostics and boundaries

Logs are stored in `~/.pi/agent/codex-wire/logs/` (or under `PI_CODING_AGENT_DIR`). They contain counts, capability flags, timestamps, numerical allowance headers and keyed digests. They omit credentials, account IDs, prompts, tool arguments/results and opaque routing tokens. Digest keys remain in memory, so digests are comparable only within one logger lifetime. Remove the log files when no longer needed.

New records also include root/child session IDs, lifecycle-derived request
purpose/origin, per-attempt IDs, prewarm-to-inference links and full-input
fallback reasons. `node ledger.mjs <run.jsonl> [...]` aggregates terminal
provider usage once per attempt. It does not add the overlapping decoder usage.
Legacy records without attempt IDs are identified and excluded from these
attempt totals. Missing coverage and conflicting response usage are reported.
Allowance reset counters are retained for comparison, not assigned causally to
individual concurrent requests.

Requests through the registered `openai-codex` provider are covered, including SDK children that inherit it. The child adapter fills in its session ID for SDK summary calls that omit one. Child launch fails closed if the root Wire registration is absent or replaced. Auxiliary window IDs are persisted in the host session's custom entries and survive provider reactivation. Independently created runtimes need the bundle loaded; client selection is shared through the agent directory. Proxy environment settings apply to WebSockets; SSE continues through Pi's supplied fetch implementation.

This is application-protocol emulation, not byte-for-byte native execution. It uses Pi's runtime and Node's networking stack. The transport is pinned to a source version. Unsupported tool namespaces fail explicitly. The model-visible Pi prompt and tools are deliberately retained so identity comparisons hold the workload constant. New native protocol features require a source review and tests before adoption.

No inference or allowance-consuming comparison is run by installation or activation. A user prompt initiates requests.

## Verify locally

```sh
npm test
```

The tests use local HTTP/WebSocket servers and fake credentials, plus Pi's actual serializer/parser. They cover native field projections, turn isolation, continuation, prewarm, fallback, cancellation, catalog failures, tool calls, privacy and report accounting.

Source map:

- `identity.ts`: `login/src/auth/default_client.rs`, `terminal-detection/src/lib.rs`; `native-os-info.ps1` follows the Windows APIs in the pinned `os_info 3.14.0` dependency.
- `protocol.ts`: `core/src/session/session.rs`, `core/src/responses_metadata.rs`, `codex-api/src/requests/headers.rs`.
- `compression.ts`: `features/src/lib.rs`, `core/src/client.rs` (compression and routing-header gates).
- `transport.ts`: `core/src/client.rs`, `codex-api/src/endpoint/responses_websocket.rs`, `codex-api/src/sse/responses.rs`.
- `model-shape.ts`: `core/src/client_common.rs`, `tools/src/tool_spec.rs`, `protocol/src/openai_models.rs`.
- `catalog.ts`: `codex-api/src/endpoint/models.rs`, `models-manager/src/manager.rs`, `models-manager/src/model_info.rs`.

All reference paths are under the pinned repository's `codex-rs/` directory. Model instructions are not copied from that repository.
