# Web search

Two tools for every model:

| Tool | Takes | Returns |
|---|---|---|
| `web_search` | `goal` (what to find, as a sentence) and `queries` (one or more short keyword searches) | Ranked pages with dated excerpts that usually answer the goal |
| `web_fetch` | `urls` (one or more), optional `goal`, optional `full` | Excerpts focused on the goal, or each page's whole text, and which pages could not be read and why |

Pages that need JavaScript, PDFs and sites behind bot checks are read by the service. Pages the service cannot read,
such as sites that turn away its data-centre addresses, are then requested from this computer, and so are local
network addresses (loopback, private ranges, Tailscale, `.local` and names without a dot), which the service cannot
reach. Such a request does not run JavaScript; it returns the text of the page's `<main>` or `<article>`, or its body,
with the result marked "read from this computer". Pages behind a sign-in or a bot check that needs a browser need the
browser tools.

## Service

**Parallel** runs them, through its MCP server, `https://mcp.parallel.ai/mcp` (only its `web_search` and `web_fetch`
tools). Without a key it is free and rate-limited; each call carries the model's name, and the session ID the server
returned to the conversation's previous call, which it uses for rate limiting. With an API key, saved from Desk's
Settings → Accounts & connections in `web-search.json` in Pi's agent folder (readable only by the user) or set as
`PARALLEL_API_KEY`, calls are billed to the account at the Search and Extract APIs' prices (fast mode: $1 per 1,000
searches, whatever the number of queries, and $1 per 1,000 pages read) at higher limits, and the cost each call
reports is recorded in service usage. Removing the key returns the computer to the free service.

Output is cut once, at 16,000 characters, by `pi-output-budget`, which keeps the rest retrievable.
