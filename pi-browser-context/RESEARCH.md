# Browser implementation comparison

## Sources inspected

- Public Codex repository at commit
  [`aee8a55ab6010f1d53e741edec74dbcffa07bcfe`](https://github.com/openai/codex/tree/aee8a55ab6010f1d53e741edec74dbcffa07bcfe).
  Its [`mcp.rs`](https://github.com/openai/codex/blob/aee8a55ab6010f1d53e741edec74dbcffa07bcfe/codex-rs/core/src/tools/handlers/mcp.rs)
  handles MCP orchestration and Node REPL/code-mode result evidence. It is not
  the Desktop browser engine.
- Locally installed Codex Desktop **26.903.9818.0**, bundled browser plugin
  **26.903.71938**. Inspected `scripts/browser-client.mjs`,
  `scripts/browser-service.mjs`, plugin configuration, accessibility docs and
  the unified computer-use launcher. Also extracted the Electron build from
  `app.asar` into temporary storage, verifying the extracted bytes against
  the archive's SHA-256 integrity records. No Desktop binaries or bundled
  implementation files are included in this repository.
- Installed Playwright MCP **0.0.80**, its source/configuration and a local
  browser fixture exercised through the existing connection.

SHA-256 of the inspected Desktop browser files:

| File | SHA-256 |
|---|---|
| `browser-client.mjs` | `3fde147aa3779bfc112aa91cbab60fde99dc494f7de76c3766ffeb9b1dc7ccae` |
| `browser-service.mjs` | `4a4bea84bcbaa820a7f67cd8d3ce7aa01d5dfd1207367d9d43125ab2c5e1e381` |
| `browser-accessibility.wasm.br` | `97d2773f1f0d3f890e2dc8bbf7da5745cfb9c2686d893579ffc35bb9608185ee` |

## Connection and execution

The inspected in-app path is:

```text
model's JavaScript call
  → persistent native Node REPL
  → browser-client.mjs
  → trusted nodeRepl.rpc browser service
  → length-prefixed JSON-RPC over a local named pipe
  → Desktop's conversation-bound browser backend
  → Electron webContents.debugger.sendCommand
  → Chromium CDP
```

The browser service discovers `iab`, `extension` and `cdp` backends. On
Windows it enumerates the `\\.\pipe\codex-browser-use` prefix; on Unix it
looks under `/tmp/codex-browser-use`. Frames contain a four-byte
little-endian byte length followed by UTF-8 JSON. `getInfo` supplies backend
type, capabilities and metadata. Backend filtering and preferred-browser
selection happen before exposing browsers through `agent.browsers`.

In-app browsers must match the current `codexSessionId` and, when supplied,
the app-build flavor. Desktop starts a backend for a conversation, validates
its route for requests, checks tab ownership and dispatches commands through
Electron's debugger API, including child-target sessions. Copying the REPL
does not create that Desktop route or transfer a browser's authentication.

The other backend types use the same browser-service protocol. Their presence
does not make an arbitrary Chrome debugging URL discoverable: a compatible
backend must expose the protocol. The installed service's extension/CDP
client paths were inspected; a real extension/native-host or external-CDP
connection was not exercised in this investigation.

Locators and actions do use Playwright code. The bundle includes
`PlaywrightInjected.InjectedScript`, injected selector worlds, action
deadlines and incremental ARIA snapshots. This is neither "no Playwright"
nor ordinary Playwright MCP: Playwright machinery sits alongside Codex's
own CDP, security, capability and observation layers.

## Observations

The client sends structured browser commands over trusted `nodeRepl.rpc`.
`tab.ax.get()` retrieves accessibility state without emitting it;
`tab.ax.write()` emits state, a screenshot, or both. Accessibility actions
return an empty object rather than automatically printing a fresh tree.
The skill batches related actions and one observation in a persistent
JavaScript session.

The service gathers CDP frame, DOM and accessibility information. It maintains
an accessibility revision and calls `buildRevision` in automatic-diff mode,
unless diffing is disabled. The revision renderer is bundled WebAssembly;
the JavaScript call site, not the algorithm inside that binary, was inspected.
Playwright snapshots also remain available through `incrementalAriaSnapshot`.

The AX surface is gated. The inspected `HY` capability function considers
`BROWSER_USE_TINYSKY_ENABLED`; CDP also has
`BROWSER_USE_ENABLE_TINYSKY_ACCESSIBILITY`. In-app and extension backends
consult `codex-browser-use-tinysky` feature configuration, with different
defaults. Enabling this surface sets `Tab.ax` and disables `Tab.cua` and
`Tab.dom_cua`. It is not evidence that every Codex session uses AX.

The newer unified launcher configures a native Node REPL with trusted browser
and computer services. Its bundled MCP entry is disabled by default. Its
presence alone does not establish which interface a particular Desktop
session uses.

## Local runtime probe

The installed native REPL and browser package were tested in an isolated
temporary process, without model requests, Desktop credentials or session
history. The process initialized MCP, exposed `js`, module-path configuration,
reset and turn-ended tools, and initialized browser access after supplying
its required local module paths and fresh session/turn identifiers.
The initial browser discovery returned an empty list.

A subsequent isolated protocol fixture supplied a fresh named pipe, synthetic
backend metadata and fresh session/turn identifiers:

| Fixture | Native `agent.browsers.list()` |
|---|---|
| CDP backend, different metadata session | One browser |
| In-app backend, matching session | One browser |
| In-app backend, different session | Empty list |

All three completed without a tool error. Initial fixture attempts failed
because the temporary browser package was incomplete; those are not discovery
results. The successful run used a complete copy of the installed package.

This demonstrates independent REPL initialization, protocol discovery and the
in-app session filter. The fixture has no browser engine, credentials or real
tabs; it does not establish action, screenshot or authenticated-browser parity.
An empty initial list is not evidence that standalone integration is impossible.

## Recommendation

Keep the working authenticated Playwright connection for the current release.
Its current model-facing improvements are:

1. Discover tool schemas through the MCP gateway on demand.
2. Batch related actions using the existing code tool and return focused facts.
3. Emit accessibility changes for repeated explicit snapshots, retaining
   complete observations as immutable local artifacts.
4. Leave file-only automatic snapshots and screenshots unchanged.

For the next browser implementation, prefer **one persistent Playwright
execution surface with explicit observations**, not a recreation of Desktop.
Use a maintained Playwright implementation for browser operations, a small
per-Pi-session worker for JavaScript state and one tool plus API guidance.
Actions should return focused results; observations should be requested
explicitly. Bind observation state and owned tabs to that session and reset
them on navigation or session replacement as appropriate.

This should replace the current overlapping model-facing browser tools and
text-diff layer, rather than adding another parallel browser stack. Reusing
the current authentication requires an explicit connection/ownership cutover;
that cutover has not been implemented or approved here.

| Option | Assessment |
|---|---|
| Existing Playwright MCP | Smallest immediate change; working connection and batched code, but bindings do not persist between code calls. |
| Persistent Playwright frontend | Recommended next architecture: retain Playwright's browser handling and adopt explicit execution/observation separation. Requires connection and lifecycle verification. |
| Installed Codex runtime plus a compatible backend | Viable local experiment; retains the actual client and AX renderer. Adds trusted-RPC configuration, native runtime/version coupling, backend adaptation and feature gates. It does not require replacing Pi inference, but is not the smallest implementation. |
| Installed `pi-chrome` bridge | Already supplies CDP access and session authorization for a signed-in Chrome profile. Potential backend, not a drop-in replacement for the current authenticated Playwright session or the full observation engine. No authorization was changed. |

Codex models can use JavaScript and documented Playwright APIs in Pi.
Neither inspected source nor these probes establish their training mixture,
an advantage from identical private API names, or equal task performance.
The recommendation follows the observed interface design and maintenance
cost, not a claim about undisclosed training data.

[Microsoft's Playwright CLI guidance](https://playwright.dev/docs/getting-started-cli)
also recommends CLI/skills for coding-agent token efficiency.
[Playwright CLI](https://github.com/microsoft/playwright-cli) and
[agent-browser](https://github.com/vercel-labs/agent-browser) remain reasonable
alternatives for a new browser setup. They are not drop-in replacements for
ownership of the existing authenticated session, and no local comparison has
established a benefit from switching.

## Local source map

These line numbers refer to temporary Prettier-expanded copies of the
versioned bundles, not to original development source:

| Source | Relevant locations |
|---|---|
| `browser-service.pretty.mjs` | `fa` (~9532): pipe root; `uM` (~45976): discovery/filtering; `HY` (~46118): AX gating; `ks`/`Xm` (~45394–45550): framed socket transport |
| `browser-service.pretty.mjs` | `captureAX` (~34258): frame/DOM capture and `buildRevision`; `incrementalAriaSnapshot` (~32377); `PlaywrightInjected` (~35518) |
| `browser-client.pretty.mjs` | AX get/write (~6547–6660); response side effects (~7985–8020); trusted setup (~8158) |
| Electron `main-CMBCj4XL.js` | `getInfo` (~87067), route validation (~87298), `sendDebuggerCommand` (~88319), `ensureBackendForSession` (~89855) |

The public [Codex MCP handler](https://github.com/openai/codex/blob/aee8a55ab6010f1d53e741edec74dbcffa07bcfe/codex-rs/core/src/tools/handlers/mcp.rs)
is useful for orchestration but does not replace these Desktop sources.
The separate [search comparison](../pi-web-search/README.md) describes
the Codex service used by Pi's web-search tool.

## Evidence and limits

The local MCP cache contained 24 Playwright tools with **16,622 characters**
of names, descriptions and JSON schemas. Disabling direct registration removes
that inventory from the always-present tool set; gateway discovery still has
its own cost.

An offline 1,000-row accessibility fixture with one changed row produces a
diff smaller than 1% of the full tree before artifact references. Tests also
cover complete artifact recovery, new baselines, output preservation and
late completion after branch replacement.

These are character counts and deterministic checks, not subscription-usage
measurements or an end-to-end model benchmark. No inference probe was used.
