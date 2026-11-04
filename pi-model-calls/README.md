# pi-model-calls

`ask_model` gives programs free-text answers from one model: summaries, drafts, extractions and judgements that
need more than `models.classify`'s typed answers. The model, its effort and the API key are chosen per computer in
Desk, under Settings → Accounts & connections → Model calls; agents can't pick another.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `string` | required | The request, with the text it needs |
| `system` | `string?` | — | Instructions that frame the answer |
| `max_tokens` | `integer?` | 16000 | Output token limit, including reasoning; capped at the model's own |

It returns `{text, cost}`, with `truncated: true` when the answer reached `max_tokens`. `cost` is in USD at the
API prices in Pi's catalog.

The key is sent with every request, so calls are billed to it even when the provider also has a subscription sign-in
in Pi. Only providers whose API keys Pi can take are offered. The choice is saved in `model-calls.json` in Pi's agent
folder, readable only by the user, and read on every call, so a change applies to running conversations at once.

Each call is recorded in the computer's service-usage ledger under its provider, and its usage counts in the
conversation's cost. Once the day's recorded calls reach the daily limit (default $5; days are UTC), calls fail until
the next day. Up to 8 calls run at once in a conversation; further calls wait, so the limit can be overshot by calls
already running.
