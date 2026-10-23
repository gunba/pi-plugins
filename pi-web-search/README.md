# Web search

Two tools for every model:

| Tool | Takes | Returns |
|---|---|---|
| `web_search` | `goal` (what to find, as a sentence) and `queries` (1–5 short keyword searches) | Ranked pages with dated excerpts that usually answer the goal |
| `web_fetch` | `urls` (up to 20), optional `goal`, optional `full` | Excerpts focused on the goal, or each page's whole text, and which pages could not be read and why |

Pages that need JavaScript, PDFs and sites behind bot checks are read by the service. Pages behind a sign-in need the
browser tools.

## Service

**Parallel** runs them by default, through its MCP server, `https://search.parallel.ai/mcp`, which is free without an
account and rate-limited. Each call carries the conversation's session ID and model, which its free tier uses for
rate limiting.

**Exa** runs them instead on a computer with an Exa API key: Desk's Settings → Web search saves one in
`web-search.json` in Pi's agent folder (readable only by the user), or set `EXA_API_KEY`. Exa ranks higher in the
Artificial Analysis Search Index and is billed per request: each query of a `web_search` is one search, with the goal
passed as its objective, and the results are interleaved by rank; `web_fetch` reads pages through Exa's contents
endpoint. Removing the key returns the computer to Parallel.

Output is cut once, at 16,000 characters, by `pi-output-budget`, which keeps the rest retrievable.
