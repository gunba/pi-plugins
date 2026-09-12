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
  the unified computer-use launcher. These bundled packages identify
  themselves as proprietary; none is included in this repository.
- Installed Playwright MCP **0.0.80**, its source/configuration and a local
  browser fixture exercised through the existing connection.

SHA-256 of the inspected Desktop browser files:

| File | SHA-256 |
|---|---|
| `browser-client.mjs` | `3fde147aa3779bfc112aa91cbab60fde99dc494f7de76c3766ffeb9b1dc7ccae` |
| `browser-service.mjs` | `4a4bea84bcbaa820a7f67cd8d3ce7aa01d5dfd1207367d9d43125ab2c5e1e381` |
| `browser-accessibility.wasm.br` | `97d2773f1f0d3f890e2dc8bbf7da5745cfb9c2686d893579ffc35bb9608185ee` |

## What the Desktop implementation does

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
Browser discovery returned an empty list.

That demonstrates that the REPL can run independently; it does not demonstrate
an independent connection to the existing authenticated browser. Reusing
Desktop's full integration would add host-connection and lifecycle work that
the existing Playwright connection does not require.

## Choice

Keep Playwright's working browser connection and improve the model-facing
interface:

1. Discover tool schemas through the MCP gateway on demand.
2. Batch related actions using the existing code tool and return focused facts.
3. Emit accessibility changes for repeated explicit snapshots, retaining
   complete observations as immutable local artifacts.
4. Leave file-only automatic snapshots and screenshots unchanged.

This follows the useful separation between actions and observations without
requiring a new browser profile or Desktop process. It is not a replica of
Codex's proprietary revision engine, browser permissions or computer-use stack.

[Microsoft's Playwright CLI guidance](https://playwright.dev/docs/getting-started-cli)
also recommends CLI/skills for coding-agent token efficiency.
[Playwright CLI](https://github.com/microsoft/playwright-cli) and
[agent-browser](https://github.com/vercel-labs/agent-browser) remain reasonable
alternatives for a new browser setup. They were not selected here because
changing ownership of the existing authenticated session offers no demonstrated
benefit over correcting its schema and observation overhead.

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
