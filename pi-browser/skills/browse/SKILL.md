---
name: browse
description: Inspect and control websites through the native Chrome DevTools tools. Use for authenticated web applications, browser research, form editing and UI verification.
---

# Browse

Use `chrome_devtools_load` with a task-oriented query to expose the needed
capabilities. The package provides list, select, navigate, evaluate and
screenshot tools; it is not an MCP server.

List pages and pass an explicit string `pageId` to each page operation.
Omitting it selects the current or first page. In particular, `navigate`
reuses an existing page; it creates one only when none exists.

Use a task-owned tab or the existing tab identified by the user. The native
package has no create/close tool. Use the classic CDP HTTP endpoint configured
in the agent directory's `pi-chrome-devtools.json`:

- `PUT /json/new?<URL-encoded destination>` creates a tab and returns its `id`.
- `GET /json/close/<target-id>` closes that tab.

Record the created ID and leave unrelated tabs alone.
After reconnecting, re-list pages and verify the task's target before acting.

Use `chrome_devtools_evaluate` with an `expression` for focused observations
and DOM interactions. Expressions run directly in the page. For example:

```js
[...document.querySelectorAll("main a")].slice(0, 20)
  .map(a => ({text: a.innerText, href: a.href}))
```

The returned CDP object holds the value in `result.value`; JavaScript
exceptions appear in `exceptionDetails`. Navigation returns before the page
necessarily finishes loading. Read the relevant state after an interaction.

Return selected fields rather than whole HTML. Use
`chrome_devtools_screenshot` for visual checks; `savePath` must remain inside
the working directory or OS temporary directory. Large text uses Pi's normal
`read_artifact` references.
