# Web search

Two tools for every model, through [Parallel](https://parallel.ai)'s search service:

| Tool | Takes | Returns |
|---|---|---|
| `web_search` | `goal` (what to find, as a sentence) and `queries` (1–5 short keyword searches) | Ranked pages with dated excerpts that usually answer the goal |
| `web_fetch` | `urls` (up to 20), optional `goal`, optional `full` | Excerpts focused on the goal, or each page's whole text, and which pages could not be read and why |

Pages that need JavaScript, PDFs and sites behind bot checks (the ATO's legal database, the Federal Court) are read
by Parallel. Pages behind a sign-in need the browser tools.

**Access.** The tools call Parallel's MCP server, `https://search.parallel.ai/mcp`, which is free without an account
and rate-limited. A Parallel API key raises the limit: set `PARALLEL_API_KEY`, or add
`"parallel": { "type": "api_key", "key": "…" }` to Pi's `auth.json`. Each call carries the conversation's session
ID and model, which Parallel's free tier uses for rate limiting. Parallel advertises no training on customer data.

**AustLII.** Its terms forbid AI use of its content, including retrieval while answering, so AustLII results are left
out of searches and AustLII URLs are not read. Legislation is on legislation.gov.au, rulings and determinations on
the ATO legal database, and judgments on the courts' own sites.

Output is cut once, at 16,000 characters, by `pi-output-budget`, which keeps the rest retrievable.
