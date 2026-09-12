# Browser context

Keeps the configured Playwright browser and its authentication while reducing
repeated observations. The bundled `browse` skill uses batched Playwright
actions and focused return values.

Explicit inline accessibility snapshots are compared with the previous
observation of the same page, tab and scope. Small changes replace repeated
trees; complete observations are retained as immutable `read_artifact` outputs.
Navigation to a different URL, compaction, branch changes and reload establish
a fresh baseline. File-only snapshots stay file-only. Errors, images and
unrecognised output remain unchanged.

```text
/browser-context diff
/browser-context full
```

The extension supports both direct Playwright tools and the `mcp` gateway.
For on-demand schemas with `pi-mcp-adapter`, set the Playwright server's
`directTools` to `false`; the gateway can discover and call the tools without
placing every browser schema in every model request.

This changes the observation interface, not the browser engine. It does not
create a new profile, copy cookies, close existing tabs, or invoke Codex
Desktop. See [the implementation comparison](RESEARCH.md).
