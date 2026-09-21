---
name: browse
description: Inspect and control websites through the configured Playwright browser. Use for authenticated web applications, browser research, form editing and UI verification.
---

# Browse

Use the existing Playwright MCP connection. Discover tools with
`mcp({search:"browser_run_code"})` or a specific tool name. Call discovered
non-direct MCP tools through the gateway; call direct tools normally.

`browser_run_code_unsafe` can batch related Playwright actions and return a focused
observation. The function receives
the current `page`; the browser persists across calls, but local JavaScript
bindings do not.

```js
async (page) => {
  await page.getByRole("button", {name: "Details", exact: true}).click();
  const dialog = page.getByRole("dialog");
  return await dialog.ariaSnapshot();
}
```

Use a fresh accessibility observation to establish targets. Prefer a scoped
snapshot, `browser_find`, or a locator query over another full-page tree.
Use screenshots for visual or coordinate-dependent work.

Snapshot responses may contain changes against the previous observation.
`+` introduces current lines and `-` removes old lines. Complete observations
are retained under the supplied `read_artifact` IDs. Those artifacts are
historical evidence, not a live view. `/browser-context full` disables diffs.

After editing, inspect the saved state. Pause a batch where a user decision or
approval is needed.
