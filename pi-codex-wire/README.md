# Pi Codex Wire

The always-enabled Codex transport included in `pi-plugins`. Pi retains its prompts, tools, agent loop and session interface.

The advertised core version follows the latest official stable [Codex release](https://github.com/openai/codex/releases/latest). Request bodies follow **Codex CLI 0.166.0**, commit [`6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`](https://github.com/openai/codex/tree/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856), checked against requests the official 0.166.0 binary sent to a local server. The original implementation reference is **Codex CLI 0.159.1**, commit [`8e68a98ef03cdde76d2e6800791ebdf1b3b95b24`](https://github.com/openai/codex/tree/8e68a98ef03cdde76d2e6800791ebdf1b3b95b24). The bundle requires Pi **1.0.4+** and Node **22.19+**.

## Installation and activation

Install or update the main package:

```sh
pi install https://github.com/gunba/pi-plugins
```

The parent manifest loads Wire automatically. Do not register this subdirectory separately. Remove any old standalone Wire registration, then reload Pi. Your saved model and authentication are unchanged. For a checkout whose dependencies were removed, run `npm ci --omit=dev --legacy-peer-deps` at the repository root.

The package installs its Pi serializer dependency explicitly. A native ESM module
resolves its public subpaths independently of the extension loader's root-module
aliases, supporting both the bundled CLI and SDK child runtimes. The resolver
has a stable interface; the TypeScript module selects SDK exports on each Pi
reload, so an update cannot leave newly added helpers missing from a cached
native export list.

Codex mode is mandatory on startup, resume, fork and reload. The old mode flag, mode-switch commands and saved `default-mode` setting are no longer used. If activation fails after loading, Codex requests are blocked rather than sent through the original provider.

Use `/codex-wire status` to see the client identity, last request outcome and diagnostic file. `/codex-wire reconnect` creates fresh transport state without disabling Wire. Activation is not itself a successful request. Changes require an idle session. The plugin reuses Pi's existing `openai-codex` authentication.

## Fast mode

Use `/fast on`, `/fast ultrafast`, `/fast off`, or `/fast status`. Desk exposes
Standard, Fast and Ultrafast in its Speed selector. The preference starts **off**
and is saved in `~/.pi/agent/codex-wire/fast-mode`; other running Pi processes pick
up changes after `/reload`. Existing `on` preferences remain Fast. Selecting a
speed does not change the model or reasoning level. Fast requests
`service_tier: "priority"`; Ultrafast requests `service_tier: "ultrafast"` on
ChatGPT-authenticated Codex responses and native compaction only when the live
model catalog offers that tier. API-key and custom-endpoint requests are not
switched. An unavailable tier stays Standard with a warning.
The backend can still downgrade an eligible request; the diagnostic log records
the requested and reported service tiers separately.

[Codex speed modes](https://learn.chatgpt.com/docs/agent-configuration/speed)
use more ChatGPT credits where available. Ultrafast access depends on the account
and model; it is not implied by Fast access. Pi's local cost estimates are not
the final subscription-credit charge. No request is sent just by toggling the
preference.

## CLI and Desktop identities

CLI identity is the initial client selection. `/codex-wire client desktop` selects and saves Desktop identity; `/codex-wire client cli` switches back. `--codex-wire-client cli|desktop` overrides the saved client at startup. Both choices keep Wire enabled and use the same pinned protocol and Codex version header. On Windows and Linux, neither client needs a saved User-Agent profile.

The Desktop profile uses originator `Codex Desktop` and the native app-server User-Agent suffix `(Codex Desktop; 26.903.61454)`. The application version was read from the installed official Electron package, rather than its different Windows Store version. `--codex-wire-desktop-version` permits an explicitly selected application version. The native [initialization code](https://github.com/openai/codex/blob/8e68a98ef03cdde76d2e6800791ebdf1b3b95b24/codex-rs/app-server/src/request_processors/initialize_processor.rs) defines the client-name/version suffix. The advertised core version is resolved independently from the application suffix. This emulates Desktop initialization; it does not claim to reproduce the installed Desktop binary or every feature of the latest core.

Desktop identity applies to both catalog and inference requests. Switching clients discards the old catalog and connections. Conflicting Desktop originator overrides are rejected. This is request-identity emulation, not the Desktop runtime, its attestation or a guarantee of Desktop allowance treatment.

`--codex-wire-transport auto` uses WebSockets with HTTP/SSE fallback. `--codex-wire-transport sse` fixes the transport to HTTP/SSE.

If an established WebSocket closes, errors, fails to send or times out before
completion, Wire surfaces the failure and selects HTTPS/SSE for subsequent calls
on that routing session. Pi's existing retry policy decides whether to try again;
For these transport failures, Wire neither replays the interrupted stream nor adds or resets retries. This
applies to ordinary responses and summaries, including failures after partial
output. Model, effort, prompt and tool content stay unchanged.

Fallback is local to the affected routing session. In `auto` mode, the next
request after a 30-second cooldown tries WebSocket again. Repeated failures double
the cooldown up to five minutes; a completed WebSocket inference resets it. There
are no idle probes or mid-response switches. The first recovered request sends
full context; subsequent compatible requests use WebSocket continuation again.
Thread, cache and context-window identities are retained. Explicit `sse` mode
never tries WebSocket.

The UI reports each fallback episode once, not each recovery attempt. Diagnostics
record the cooldown and recovery attempts/completion. Cancellation, deliberate
shutdown, completed responses, model error responses and invalid payloads do not
activate stream fallback.
`websocket-failure` diagnostics record the close code, elapsed/idle milliseconds,
event count and whether output began—not close-reason text, error text or content.
SSE diagnostics likewise record first-event time, latest reasoning-update time,
event counts, idle time and maximum event gaps without recording output text.
A socket termination before completion is reported as an interrupted response
stream, not simply `terminated`. These timings describe received traffic, not
the model's compute time or the location of a network fault.

## Capacity recovery

Pi agents can run unattended. When a stream fails with `policy_capacity_unavailable`
before any output item, text, reasoning or tool-call data arrives, Wire waits and
resends the identical request internally. The failed attempts are hidden from
Pi's decoder; the model, request IDs, history, tools and cache keys stay unchanged.

There are at most four resends. Valid `Retry-After` seconds or HTTP dates in the
stream error's headers set the wait, capped at ten minutes. Without valid advice,
the waits are 30, 60, 120 and 240 seconds: 7.5 minutes total. Scheduled waits also
have a ten-minute total ceiling; if advice will not fit the remaining budget,
recovery ends rather than resending early. These are wait budgets, not limits on
time spent receiving a model response.

Stop, steering, shutdown and response-body cancellation interrupt the wait.
Output already received prevents any capacity resend. Exhaustion returns an
error stating the time waited, with wording Pi does not classify as retryable,
so Pi's own retries cannot multiply the capacity budget. Each new request,
including a tool follow-up after success, starts with a fresh budget.

Diagnostics record each wait's attempt, planned delay, advice source, actual
elapsed wait and cancellation, plus the reason recovery stopped. They contain no
prompt, raw error text or credentials. Other transient and HTTP-status errors
retain Pi's retry policy. This bounded capacity recovery deliberately differs
from interactive Codex, which fails without retry advice; it never switches models.

## Native compaction

A portable model handoff keeps its source branch anchored while summarizing.
Wire's transport-window bookkeeping may be appended without invalidating the
result; messages, other entry changes and navigation away from that anchor still
prevent the switch. The handoff uses the source model's selected reasoning level,
so a high-effort summary can take several minutes.

Codex sessions use native compaction through Responses, with the
`compaction_trigger` input used by Codex CLI 0.155.0. Pi still chooses the cut
point and recent messages to retain. Existing context-limit settings, including
the reserve and recent-token settings, are unchanged. The history prefix and
any split-turn prefix are sent together using the selected model and effort.

Wire collects exactly one encrypted compaction item and requires a successful
`response.completed` event before saving it in the compaction entry's `details`.
The caption identifies the entry; it is not a prose summary. A partial stream,
invalid checkpoint, error or cancellation cannot replace the previous context.
The dedicated `/responses/compact` route is not used; its authorized live probe
returned HTTP 404.

The checkpoint replaces prior assistant/tool history and earlier checkpoints.
User messages are retained ahead of it, newest first within Codex's 64,000-token
text-retention estimate; the boundary message preserves its beginning and end
with a truncation marker. Images within retained messages remain intact. Pi's
recent tail is kept separately. Original session records are not rewritten.

Wire replays the checkpoint after reopening or forking the session, including
after switching Codex accounts. Account changes reset authenticated connections,
continuation and turn state; they do not discard the checkpoint. Existing saved
entries replay without modification. OpenAI remains responsible for accepting
the encrypted content. Replay is restricted to the ChatGPT Codex Responses
endpoint, and a different provider is blocked while that checkpoint is in
context; navigating to a branch before it remains possible.
Native-checkpoint branches can also be summarized into text when navigating
elsewhere. Forked children receive independent copies of checkpoint details.

Compaction uses Pi's public message serializers and active tool schemas. These
schemas describe functions for compaction; ordinary response requests retain
their existing grammar and deferred-tool behavior. Tool arguments and results
keep their pairing. SDK children inherit the compactor with their own session,
routing state and settings. Provider ownership and compaction follow Pi’s native
registration, not the temporary provider wrappers created by model overrides.
Refreshing context limits retains Wire and child compaction while applying the
configured model metadata and authentication.

Compaction shares Wire's WebSocket/SSE transport, compression, idle deadlines,
allowance observations and cancellation. Prewarming is skipped for compaction.
The capacity-recovery exception above also applies to compaction; other errors
retain Pi's configured caller retry budget and backoff. An interrupted
WebSocket is not replayed immediately; the caller's next attempt uses SSE.
Errors explicitly cancel Pi's compaction hook, preventing prose fallback.
Usage is recorded when the response supplies counters; absent usage stays unknown.

An authorized two-request Astra/xhigh check completed native compaction and
recovered the exact synthetic test code through its encrypted checkpoint, with
no retries. Local installed-Pi tests cover persistence, resume, forks, tree
navigation, failed streams and retry boundaries. This verifies the compaction
path; the original active-stream WebSocket disconnect remains unexplained.

### Diagnosing interrupted requests

Request records include the effective timeout and whether streaming was requested.
Pi's `httpIdleTimeoutMs` setting controls the default header/idle wait; an explicit
provider timeout takes precedence. For streaming responses these are not limits
on total generation time; native compaction uses the same idle deadline.
Pi's supplied-fetch deadline also covers catalog lookup and transport setup.
Wire propagates that signal, so an expired attempt cannot continue through a
slow catalog lookup into inference. A headers-timeout message alone does not
prove that the network was waiting for response headers throughout that time.
For SSE, the body deadline renews on complete data events. Heartbeat comments
and unfinished event fragments do not extend it. Lite event normalization reads
across network-chunk boundaries, and cancellation terminates both the network
reader and Pi's waiting response stream.

WebSocket failures include the last allowlisted event type, event counts, byte
counts, largest frame, longest gap, negotiated compression, and TCP end/close/error
state. `websocket-progress` records the first event and first text delta.
HTTP upgrade/response records retain only allowlisted server request IDs for
support correlation, not credentials, routing tokens, or arbitrary headers.

SSE requests record Undici's request-created, headers-ready, body-sent and
response-headers stages, followed by fetch return/error. These are matched by
request identity and endpoint, including across pooled callbacks; unrelated
requests are excluded. `headers-ready` occurs before the header write;
`body-sent` is a client-side observation, not proof the
server accepted or processed the request. Non-Undici fetchers may expose only the
fetch return/error stage. Body failures and EOF records distinguish received
bytes/events from a missing terminal event. Error codes are allowlisted; raw
errors, payloads, addresses and TLS keys are not recorded.

These observations separate a local timeout or decoder failure from an
interrupted transport. They cannot by themselves distinguish a backend failure
from every possible network intermediary, or establish why the server stopped.

WebSocket prewarming is **off by default**. `/codex-wire prewarm on|off`
saves the choice; `--codex-wire-prewarm on|off` overrides it at startup. As in
Codex 0.164.0, the `generate:false` prewarm carries a standard model's base
instructions and nothing for a Lite model; the turn after it continues from it
with `previous_response_id`. This controls only the prewarm, not Wire, Codex
identity, WebSocket reuse or continuation. Reconnects follow the same setting.

`--codex-wire-compression on` matches Codex 0.159.1's default `enable_request_compression` feature. `off` disables compression, not Wire. Compression applies only to authenticated `openai-codex` requests to the Codex backend over HTTP/SSE. If zstd is selected but unavailable in Node, the request stops before inference.

On Windows, the automatic native User-Agent uses `RtlGetVersion` and `GetNativeSystemInfo`, matching the pinned `os_info 3.14.0` dependency. A local PowerShell helper reads these values once; it runs only when an emulation mode is activated. On Linux, Wire reads `lsb_release` (then `/etc/os-release`) and `uname -m` for the native OS/version/architecture fields. Terminal detection follows the native environment-only precedence and sanitization rules, including Windows Terminal and terminal hints under tmux. It does not launch Codex or terminal helpers.

For another OS, or to reproduce a captured native profile exactly, supply `--codex-wire-user-agent "codex_cli_rs/0.159.1 (...) terminal"`. It must match the selected originator. Wire refreshes the core-version prefix automatically while preserving the OS, terminal and client suffix. `--codex-wire-originator` supplies the originator; the native `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` environment variable takes precedence, with invalid header values falling back to `codex_cli_rs`.

You can save a verified native profile for this machine with
`/codex-wire user-agent codex_cli_rs/0.159.1 (...) terminal`. The profile is stored
under `~/.pi/agent/codex-wire/user-agent` and is used on activation, resume, and
reload. An explicit `--codex-wire-user-agent` overrides the saved profile. CLI and Desktop User-Agent profiles are saved separately; the current client determines which profile is written.

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
- Native model-catalog shaping: supported service tiers, reasoning/verbosity fields, function strictness, and Responses Lite tool/instruction/image transformations. As in 0.164.0, every request leads with its routing fields (`model`, `stream`, `service_tier`, `previous_response_id`) before `input`, and base instructions travel as a developer message classified `model.base_instructions` for every model (with harness attribution on Lite), not an `instructions` field. Pi's head `additional_tools` item becomes the Lite tool prefix or a standard model's top-level `tools`; later ones (tools Pi loads) stay in place. Function tools use the native field order. Tool and instruction prefixes receive deterministic, thread-scoped UUIDv5 IDs.
- Native history metadata (`history.ts`): every input item has 0.164.0's field order, a time-ordered UUIDv7 ID where Codex mints one (messages, tool outputs) and `internal_chat_message_metadata_passthrough` with its turn, creation time, content kinds and, on Lite, provenance. Turns follow Pi's messages: a user message after a reply starts one; a message during a tool loop joins it. Times come from Pi's message timestamps and the other ID bits from a hash, so every request describes an item identically. Lite records its tool and instruction prefix at the first turn, as Codex does.
- Native turn metadata: agent name, `<thread>:<n>` window IDs with their context-window ID, root turn, history initialization, sandbox mode (`danger-full-access`, which is what Pi runs with), the review and analytics defaults, model and effort, and the repository's git workspace (remotes without credentials, HEAD, uncommitted changes), read once per turn. Client metadata adds MCP attribution and the root turn; headers add `x-codex-beta-features: remote_compaction_v2`. Codex's own harness messages (skills, permissions, environment, collaboration mode) are not sent: Pi keeps its own prompt. Pi's named effort levels follow the 0.159.1 rules; parallel calls follow the prompt and are disabled in Lite mode. Unsupported original image detail becomes high outside Lite; Lite omits image detail.
- Wire owns the passive allowance footer and `/pi-usage`. Codex counters from WebSocket upgrades, stream events and SSE responses pass through `pi-codex-wire:allowance`; only allowlisted counters and plan labels cross the event bus. Claude subscription windows use Pi's native response-header event for the official Anthropic OAuth endpoint. Each provider/account keeps a separate snapshot; late headers from a changed account are ignored. No polling, extra model requests or global WebSocket interception is installed. API token limits are not presented as subscription allowance. The footer handles a 7-day window reported as the primary window.
- Codex requests prepend the selected model’s native introduction from its catalog to Pi’s existing instructions. Only the opening paragraph is copied; tools, project instructions and the rest of Pi’s policy remain intact. Unlisted models use the neutral introduction `You are Codex.`. An existing matching introduction is not duplicated.
- Desk (RPC) turns request `detailed` reasoning summaries; terminal Pi retains its `auto` default instead of adopting a catalog default of `none`. Explicit caller choices and the model's supported-parameter flag still apply. The backend may omit a readable summary; encrypted replay state is preserved separately. Diagnostics record the requested summary mode, not its content.
- Streamed `policy_capacity_unavailable` failures use bounded, abortable [capacity recovery](#capacity-recovery) before output, deliberately differing from native Codex for unattended agents. Other errors retain Pi's retry policy.
- Pi's existing serializer and model-event decoder handle tools and reasoning. As in Codex 0.165.0, missing or empty output-item IDs receive type-prefixed UUIDv7s before Pi saves the response. Added/done events share the ID, and replay retains it; existing server IDs and saved history are not rewritten. The adapter locally envelopes WebSocket events as SSE for that decoder; network WebSocket frames remain JSON. When history is replayed under a different tool-call type, incompatible optional item IDs are omitted; call/result links and saved messages remain unchanged.

On the first model request after activation or reconnect, Wire resolves the latest stable release from `https://api.github.com/repos/openai/codex/releases/latest`. This public request sends no account credentials. A one-hour cache in `~/.pi/agent/codex-wire/latest-version.json` avoids a lookup for every conversation. The selected version stays fixed for that activation so an active connection and its model catalog agree. Reconnect or reload to refresh an expired version cache. If the release service is unavailable, Wire uses the last verified version with a warning; without a verified cache it stops before inference. `--codex-wire-version` permits an explicit compatibility override.

That version is used consistently in the User-Agent, `version` header and `/codex/models?client_version=<version>` query. The catalog request uses the existing account credential and selected client identity. Wire keeps capability fields and the model’s native opening paragraph, not its complete instruction template. Diagnostics distinguish the implementation reference from the resolved identity version.

GPT-6.1 Sol is discovered through Pi's native model catalog; run `pi update --models`
to refresh it. No custom model definition is needed. Existing Desk workers need
the updated runtime as well as the refreshed catalog. Updating the advertised version
does not enable Codex's experimental in-stream effort changes, numeric effort
values, graceful-interrupt protocol, access programs or native tool execution.

Snapshots are scoped to endpoint, account and credential. Reversed completion order cannot replace another scope's capabilities. Concurrent lookups have independent cancellation; the first successful result freezes that scope, and returned metadata is detached from the cache. Aborted or failed requests do not publish snapshots. Each activation retains up to 16 catalog scopes. Catalog fetch failures or malformed entries stop the request before inference.

Model lookup follows native Codex: longest matching prefix, then a single simple provider-namespace suffix. If neither matches, the plugin uses Codex 0.159.1's fallback capabilities, displays a warning and records `nativeFallback: true`. It keeps the requested model ID and reasoning effort. The catalog is not an allowlist: a model can accept requests without appearing there. The backend still decides whether the account can use that model.

## Passive allowance status

`/pi-usage` shows cumulative recorded token/cost totals and observed subscription
windows; `/pi-usage on|off` controls its status. `PI_CODEX_USAGE_STATUS=off` disables
the status at startup. Observations are saved in the agent directory's
`codex-wire/usage.json` (or `PI_CODEX_USAGE_DIR/usage.json`).

In Pi Desk, Settings → Usage & allowance shows these same totals, passive
observations, remaining-budget bars and reset times. Child billing refreshes the
shared calculation without another model request. `/pi-usage` opens this panel.
Settings → Codex provides Fast mode and its last eligibility result, plus the
identity, prewarm and reconnect controls. These call the existing `/fast` and
`/codex-wire` handlers; they do not introduce a second preference or transport.

There is no allowance polling. The 30-second timer only updates reset countdowns.
Each instance owns its context, timer and preference; shutdown releases listeners
before clearing its status. Retired callbacks cannot restart or clear a newer
instance, and invalidated contexts stop ticking.

The shared `pi-session-usage` reducer accounts for assistant messages, billed tool
results, compaction/branch summaries, native usage entries such as cache warming,
and deduplicated child receipts. The fast footer and SDK child outcomes use the
same reducer. Recorded API costs are not subscription allowance measurements.

## Diagnostics and boundaries

Logs are stored in `~/.pi/agent/codex-wire/logs/` (or under `PI_CODING_AGENT_DIR`). They contain counts, capability flags, timestamps, numerical allowance headers and keyed digests. They omit credentials, account IDs, prompts, tool arguments/results and opaque routing tokens. Digest keys remain in memory, so digests are comparable only within one logger lifetime.

Each logger retains four parts of at most 2 MiB: the current `.jsonl` file and
suffixes `.1`–`.3`. Rotated parts retain the run header. Closing or replacing a
logger prevents late callbacks from writing again. A small `.owner` file records
its process and whether the run has closed.

Activation runs background retention outside the request path: closed runs and
runs whose process has exited are limited to 14 days and 64 MiB in total.
Active writers are excluded. Logs without ownership records, written by older
versions, are removed once none of their parts has changed for 14 days.

Records also include root/child session IDs, lifecycle-derived request
purpose/origin, per-attempt IDs, prewarm-to-inference links and full-input
fallback reasons. Summary requests with fresh routing IDs are linked to compaction
or branch-summary lifecycle events by their abort signal, without reading prompt
text or misclassifying unrelated requests made while a summary is active.

Requests through the registered `openai-codex` provider are covered, including SDK children that inherit it. The child adapter fills in its session ID for SDK summary calls that omit one. Child launch fails closed if the root Wire registration is absent or replaced. Auxiliary window IDs are persisted in the host session's custom entries and survive provider reactivation. Independently created runtimes need the bundle loaded; client selection is shared through the agent directory. Proxy environment settings apply to WebSockets; SSE continues through Pi's supplied fetch implementation.

This is application-protocol emulation, not byte-for-byte native execution. It uses Pi's runtime and Node's networking stack. The transport is pinned to a source version. Unsupported tool namespaces fail explicitly. The model-visible Pi prompt and tools are retained. New native protocol features require a source review and tests before adoption.

Installation and activation send no inference requests. A user prompt initiates requests.

## Verify locally

```sh
npm test
```

The tests use local HTTP/WebSocket servers and fake credentials, plus Pi's actual serializer/parser. They cover native field projections, turn isolation, continuation, prewarm, fallback, cancellation, catalog failures, tool calls, privacy and log retention.

Source map:

- `identity.ts`: `login/src/auth/default_client.rs`, `terminal-detection/src/lib.rs`, and the Linux parsers in pinned `os_info 3.14.0`; `native-os-info.ps1` follows that dependency's Windows APIs.
- `protocol.ts`: `core/src/session/session.rs`, `core/src/responses_metadata.rs`, `codex-api/src/requests/headers.rs`.
- `compression.ts`: `features/src/lib.rs`, `core/src/client.rs` (compression and routing-header gates).
- `transport.ts`: `core/src/client.rs`, `codex-api/src/endpoint/responses_websocket.rs`, `codex-api/src/sse/responses.rs`.
- `model-shape.ts`: `core/src/client_common.rs`, `tools/src/tool_spec.rs`, `protocol/src/openai_models.rs`.
- `catalog.ts`: `codex-api/src/endpoint/models.rs`, `models-manager/src/manager.rs`, `models-manager/src/model_info.rs`.

All reference paths are under the pinned repository's `codex-rs/` directory. Model instructions are not copied from that repository.
