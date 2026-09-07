# Verification — 7 September 2026

Environment: Windows 10.0.26100, Node 22.22.3, Pi 0.84.3.
Protocol reference: Codex 0.153.4, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`.

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
