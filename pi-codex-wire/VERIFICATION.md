# Verification — 7 September 2026

Environment: Windows 10.0.26100, Node 22.22.3, Pi 0.84.3.
Protocol reference: Codex 0.147.0, commit `be6e8eac029b183056b7e4402879f15d2c85f61b`.

| Check | Result |
|---|---|
| Repository TypeScript check | Passed |
| Plugin suite, included in full run | 43 passed |
| Full repository test file list, `--test-concurrency=1` | 340 passed, 2 skipped, 0 failed |
| Offline Pi extension load and model listing | Passed |
| Package dry-run | Passed |
| Git whitespace check | Passed |

The final serial run completed in 431 seconds. Earlier parallel attempts exposed a continuation-test failure, since fixed, and timing-sensitive Windows shell test failures. The final full serial run is green; the existing shell implementation was not changed.

The plugin tests use fake credentials and local servers. They exercise Pi's actual serializer and decoder, including a complete Responses Lite WebSocket tool-call and encrypted-reasoning roundtrip. They also cover cancellation during catalog lookup and pending handshakes, account-bound connection state, SSE header/body timeouts, context-window replacement, privacy allowlists and allowance-report accounting.

The additional regression tests cover:

- Thread-derived session/cache identity across reactivation, resume, new sessions and forks.
- Native terminal precedence, sanitization, originator overrides and explicit User-Agent profiles.
- Native Windows identity through `RtlGetVersion` and `GetNativeSystemInfo`; observed values are `10.0.26100` and `x86_64`.
- Compression feature/provider/auth/backend gates and actual compressed versus plain SSE bodies.
- Reversed account-response completion order, credential/endpoint isolation, independent cancellation, failed lookups, same-scope races and detached cached metadata.

The Windows identity reference is `os_info 3.14.0` from Codex's lockfile, verified against crate SHA-256 `e4022a17595a00d6a369236fdae483f0de7f0a339960a53118b818238e132224`.

The plugin remains opt-in. No live model comparison or subscription-accounting conclusion has been made. Use the controlled comparison in `README.md` after agreeing an allowance budget.
