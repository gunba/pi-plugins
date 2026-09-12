# Codex web search

Pi's `web_search` tool is an adapter for Codex's standalone **`alpha/search`**
service. Its display label is `web.run`. It uses the selected ChatGPT Codex
model and that model's OAuth credentials; it does not select another model,
call Perplexity or run a separate Pi summarization agent. The service's
internal implementation is not established by this client inspection.

## Provenance

[Commit `dbfda5a`](https://github.com/gunba/pi-plugins/commit/dbfda5a2f3f0a65b4125f3beb663278f1ddab741)
introduced the standalone adapter on 25 July 2026. Earlier history used
Perplexity and then `pi-web-access`; neither is the current execution path.
The adapter is based on Codex's standalone search client, not a connection to
the local browser or a wrapper around a Desktop conversation.

The current source comparison uses public Codex commit
[`aee8a55`](https://github.com/openai/codex/tree/aee8a55ab6010f1d53e741edec74dbcffa07bcfe):

- [`ext/web-search/src/tool.rs`](https://github.com/openai/codex/blob/aee8a55ab6010f1d53e741edec74dbcffa07bcfe/codex-rs/ext/web-search/src/tool.rs):
  `web.run` registration, request construction, metadata and UI events.
- [`codex-api/src/endpoint/search.rs`](https://github.com/openai/codex/blob/aee8a55ab6010f1d53e741edec74dbcffa07bcfe/codex-rs/codex-api/src/endpoint/search.rs):
  POST to `alpha/search`.
- [`codex-api/src/search.rs`](https://github.com/openai/codex/blob/aee8a55ab6010f1d53e741edec74dbcffa07bcfe/codex-rs/codex-api/src/search.rs):
  request, command and response structures.
- [`ext/web-search/src/history.rs`](https://github.com/openai/codex/blob/aee8a55ab6010f1d53e741edec74dbcffa07bcfe/codex-rs/ext/web-search/src/history.rs),
  [`extension.rs`](https://github.com/openai/codex/blob/aee8a55ab6010f1d53e741edec74dbcffa07bcfe/codex-rs/ext/web-search/src/extension.rs)
  and [`output.rs`](https://github.com/openai/codex/blob/aee8a55ab6010f1d53e741edec74dbcffa07bcfe/codex-rs/ext/web-search/src/output.rs):
  conversation context, configuration and plaintext evidence.
- [`core/src/tools/spec_plan.rs`](https://github.com/openai/codex/blob/aee8a55ab6010f1d53e741edec74dbcffa07bcfe/codex-rs/core/src/tools/spec_plan.rs):
  standalone versus hosted tool selection.

## Request path

```text
Pi tool call
  → selected model and model-registry authentication
  → POST <configured Codex base>/alpha/search
  → output text for the model; results metadata in tool details
  → display renderer for the terminal
```

For a normal `https://chatgpt.com/backend-api` model base, the adapter uses
`https://chatgpt.com/backend-api/codex/alpha/search`. It also accepts bases
ending in `/codex` or `/codex/responses`. It sends the Pi session ID as `id`.
Reference IDs are not rewritten before subsequent `open`, `click` or `find`
requests. Reference lifetime and cross-session availability remain service
behavior, not a local cache guarantee.

## Differences from native Codex

| Area | Pi adapter | Inspected native standalone tool |
|---|---|---|
| Exposure | One function named `web_search`, labelled `web.run`; eligible ChatGPT Codex models | `web` namespace with a `run` function, selected per turn |
| Commands | Same eleven top-level command/response-length fields; explicit batching and numeric constraints | Corresponding Rust command types and generated schema |
| Model | Selected `model.id` | Current call's model |
| Recent conversation | Not sent | Last two user text messages and up to 1,000 tokens of intervening assistant output |
| Reasoning | Omitted | Explicitly `None`, omitted during serialization |
| Settings | Direct caller, live external access | Configured cached/indexed/live mode, location, context size and domain filters |
| Output budget | 10,000 tokens requested; Pi's output-budget layer may archive and shorten the returned text | Current call's truncation-policy token budget |
| Identity | Model-registry auth headers, then `originator: pi` and required OAuth/account headers | Native provider/auth client, optional thread originator and turn metadata |
| Transport | One `fetch` POST with the caller's abort signal; no adapter retry or fallback | Native HTTP endpoint session using the provider retry policy |
| UI | Tool text preview and metadata retained in details | Search begin/end events with action and structured results; plaintext output supplied to the model |

Codex Wire owns the Responses transport; it does not install a global fetch
interceptor for search. Selecting Wire's Desktop identity therefore does not
replace this tool's `originator: pi` with a Desktop originator. No search
identity or request-policy changes accompany the rendering fix.

Native Codex also has **hosted web search**, which is not this adapter.
Its tool planner prefers standalone search when namespace tools and provider
capabilities permit it and the model uses Responses Lite or the standalone
feature is enabled, provided the external `web.run` executor is registered.
Otherwise an eligible provider can receive a hosted search tool specification.
These are two execution paths, not two names for the same client adapter.

## Citation rendering

Search output contains private-use content-reference delimiters, including
U+E200, U+E201 and U+E202. Showing them as ordinary terminal text produces
the reported missing-glyph artifacts. They carry source and numbered-link
references; simply removing the whole marker would lose useful information.

The registered result renderer displays readable references:

```text
[turn54view0]
L0: [0] Skip to main content
L6: [2] Download Microsoft Edge (go.microsoft.com)
```

Only presentation changes. Tool text, structured results, saved messages and
archived evidence retain their original content. Unknown content-reference
payloads remain readable bracketed text; this is not a recreation of Desktop's
rich widgets. Terminal escape sequences from source text are removed before
applying the terminal theme. Results support native independent expansion.

Tests cover the reported notation, multiple references, incomplete markers,
unknown payloads, Unicode widths, escape-sequence handling, immutable evidence
and native Pi mouse expansion. Network tests use a synthetic fetch
implementation. No live search or model-performance comparison is implied.

## Recommendation

Keep the Codex service adapter. Its remaining differences concern request
fidelity and interface behavior, not a need for another search provider.
Adding recent conversation or changing identity/settings would change what
is sent to the service and should be considered separately from rendering.
The source comparison does not establish equivalent search quality,
subscription allowance treatment or server-side processing.
