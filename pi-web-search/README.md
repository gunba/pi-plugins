# pi-web-search

Single-provider web search and guarded page fetch tools for Pi.

## Tools

- `web_search` — asks Perplexity Sonar for a concise answer with citations.
- `web_fetch` — fetches one HTTPS page with URL, redirect, content-type, size, and prompt-injection checks.

## Configuration

Set `PERPLEXITY_API_KEY` in the environment, or add it to `~/.pi/web-search.json`:

```json
{
  "perplexityApiKey": "pplx-..."
}
```

Optional model override:

```json
{
  "perplexityApiKey": "pplx-...",
  "perplexityModel": "sonar"
}
```

## Safety model

Fetched page text is wrapped as untrusted evidence and includes risk flags when common prompt-injection or hidden-text patterns are detected. `web_fetch` only fetches public HTTPS URLs, revalidates redirects, blocks URL credentials and private-network targets, limits response size, and returns text-like content only.
