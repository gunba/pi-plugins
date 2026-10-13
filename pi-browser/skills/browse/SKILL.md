---
name: browse
description: Use Chrome, with its signed-in sessions, to read, operate and check websites: web apps, forms and UI testing.
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

## Sites that refuse scripts

To read or check URLs, use `web_search` (`open`, or `check` for link checks)
rather than curl, wget or scripts. Many sites, including AustLII and the
Federal Court, answer scripts with a bot check (Cloudflare, Akamai, CloudFront),
a rate limit or a TLS failure. A script sees an ordinary 403 or connection
error. That means neither "broken" nor "fine". `web_search` names the
protection and loads such pages in a background Chrome tab, so its outcome is
the real one: `ok`, `not_found`, `blocked`, `http_error` or `network_error`.

When checking a page in Chrome yourself:

- A challenge page reloads itself. "Inspected target navigated or closed" during
  the first read is expected; wait a moment and read again.
- A page can load with HTTP 200 and still be missing. Check the title or the
  main heading for "Page not found" before calling a link good.
- If a check still shows after about 30 seconds, ask the user to complete it in
  Chrome, then try again.

