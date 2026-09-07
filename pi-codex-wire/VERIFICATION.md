# Verification — 7 September 2026

Environment: Windows 10.0.26100, Node 22.22.3, Pi 0.84.3.
Protocol reference: Codex 0.153.4, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`.

## Tool-call replay ID correction

A saved `apply_patch` function call was reproduced locally through Pi's actual serializer: grammar-tool replay produced a `custom_tool_call` retaining an incompatible `fc_` item ID. The request shaper now omits optional item IDs whose prefix does not match the outgoing call type, for both standard Responses and Responses Lite. It preserves compatible IDs, `call_id`/result pairing, reasoning items and stored messages rather than inventing replacement server IDs. Native `protocol/src/models.rs` defines the custom-call item ID as optional.

- Repository TypeScript check: passed.
- Model shaping, extension and transport regressions: **45 passed, 0 failed**.
- Read-only reproduction using the reported saved call and result: mismatch reproduced; both formats corrected; pairing and source objects unchanged.
- No session-file edits or network inference requests were used for verification.

## Allowance and connection reliability update

The allowance display observed Pi's global WebSocket implementation, but Wire uses the separate `ws` package. Wire now forwards allowlisted counters and plan labels through the extension event bus, including upgrades, prewarm events, normal WebSocket events and SSE. Tests cover a primary 7-day window, persisted values, footer updates, privacy filtering and listener cleanup.

SDK children inherit the parent's provider functions without its extension lifecycle hooks. Those functions previously captured one transport. They now select independent protocol/transport state by request session ID, retain auxiliary window identities, bound idle connections and prevent retired providers from reopening sockets. Concurrent requests, parent cancellation, per-child routing and new-turn resets are covered.

The native `websocket_connection_limit_reached` error now permits one internal reconnect before model output. Tests cover expiry during prewarm and normal streaming, full replay on a fresh connection, cancellation during reconnect, no replay after partial output, and bounded recovery even when Pi's HTTP-fetch retry setting is enabled.

| Check | Result |
|---|---|
| Final repository TypeScript check | Passed |
| Final affected transport, extension and allowance regressions | 37 passed, 0 failed |
| Broader Wire/usage run before the final retry-boundary refinement | 70 passed; 1 Windows PowerShell identity-helper timeout |
| Earlier isolated Wire/usage run in this update | 66 passed, 0 failed |
| Offline Pi extension load and model listing | Passed |
| Package dry-run | Passed |

The broad serial repository run earlier in this update recorded **390 passed, 17 failed, 2 skipped**. Nine failures were Windows symlink-permission errors; seven concerned Windows process/probe timing or shutdown; one was a body-idle test timing out during TCP setup. That test now supplies immediate headers to isolate body idleness and passes in the final regressions. An isolated shell-runtime recheck also failed. **The full repository suite is not green on this host**, and the earlier full run does not cover the later connection-expiry changes.

All new recovery and isolation checks use fake credentials and local/mock transports. No live inference probe or allowance benchmark was run for this update.

## Astra compatibility update

The original 0.147.0 catalog omitted `gpt-6-astra`. After correcting native prefix/fallback metadata lookup, a live request exposed an independent backend version gate: Astra required a newer Codex client. The 0.153.4 catalog includes Astra and selects Responses Lite.

The update was reviewed against the tagged native source, including identity, catalog resolution, reasoning mappings, routing headers, Lite prefix IDs, compression and WebSocket framing. Optional native runtime metadata is not invented. The standalone Codex CLI installation was not changed.

| Check | Result |
|---|---|
| Repository TypeScript check | Passed |
| Updated plugin suite | 55 passed, 0 failed |
| Live Astra request, medium reasoning | Returned `OK` over WebSocket with Responses Lite |
| Saved startup mode and explicit CLI override tests | Passed |
| Offline Pi extension load and model listing | Passed |
| Package dry-run | Passed |
| Git whitespace check | Passed |

The live check used a tiny standalone prompt, not the working conversation. One fresh-connection prewarm and one successful inference request completed without SSE fallback. The response reported 26 input tokens and 5 output tokens. This verifies basic connectivity and decoding, not subscription allowance treatment.

Before this update, the full repository serial suite passed with 340 tests passed and 2 skipped in 431 seconds. That historical run is not a full-suite result for the updated code. The updated code passed the repository TypeScript check and all 55 plugin tests.

The plugin tests use fake credentials and local servers. They exercise Pi's actual serializer and decoder, including a complete Responses Lite WebSocket tool-call and encrypted-reasoning roundtrip. They also cover cancellation during catalog lookup and pending handshakes, account-bound connection state, SSE header/body timeouts, context-window replacement, privacy allowlists and allowance-report accounting.

The additional regression tests cover:

- Thread-derived session/cache identity across reactivation, resume, new sessions and forks.
- Native terminal precedence, sanitization, originator overrides and explicit User-Agent profiles.
- Native Windows identity through `RtlGetVersion` and `GetNativeSystemInfo`; observed values are `10.0.26100` and `x86_64`.
- Compression feature/provider/auth/backend gates and actual compressed versus plain SSE bodies.
- Reversed account-response completion order, credential/endpoint isolation, independent cancellation, failed lookups, same-scope races and detached cached metadata.
- Native longest-prefix and namespace resolution, fallback capabilities, malformed catalog rejection and unchanged requested model IDs.
- Saved defaults across session lifecycle events and explicit CLI overrides.
- 0.153.4 routing headers, reasoning mappings, parallel-call rules and deterministic Lite prefix IDs.
- Connection-scoped prewarming, turn-state reset and renewed prewarming after reconnection.

The Windows identity reference is `os_info 3.14.0` from Codex's lockfile, verified against crate SHA-256 `e4022a17595a00d6a369236fdae483f0de7f0a339960a53118b818238e132224`.

The plugin remains opt-in. No live model comparison or subscription-accounting conclusion has been made. Use the controlled comparison in `README.md` after agreeing an allowance budget.
