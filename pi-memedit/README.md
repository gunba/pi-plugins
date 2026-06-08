# pi-memedit

Pi extension that runs incremental pruning passes over low-value conversation history. Each pass calls the current model with a dedicated pruning prompt and a plain-text transcript of eligible entries; the entries it selects are hard-deleted from both future model context and the persisted session JSONL. memedit does not summarise or compact — it removes whole entries outright.

Only entries tagged with compact `[N]` identifiers are removable; `[context]` entries are shown for context only and can never be selected.

## Candidacy

memedit never judges the whole conversation. Candidacy is incremental and decided by entry identity, not by a position in the log:

- Everything present when the session starts, resumes, or restarts is frozen as context the moment the session begins.
- Only entries this live session generates are eligible, and once a pass has judged an entry it is never re-offered — it stays in context but drops out of candidacy.
- User messages and compaction summaries are always protected (deleting a compaction can re-expand old history). The most recent assistant text answer is protected, and during live pruning the freshest turn — the latest assistant message and the tool results it produced — is protected too, because the main agent has not consumed those results yet.

The pruning request and response are never added to the conversation, and memedit's own status messages are filtered out of future model context.

## Pruning modes

- **Next-request pruning** runs before the next user request reaches the model. The pruning agent is handed that upcoming request so it can keep whatever the next step will need. If a pass is skipped for too little material, its entries stay unjudged and accumulate with later ones until a pass is worthwhile.
- **Live continuation pruning** (on by default) runs after a completed tool-using turn during a long run, once enough older unjudged material has built up. It never runs after a final assistant answer, uses a continuation-specific prompt, and shows only the session's not-yet-judged entries to keep the prompt small.

## Thresholds

Automatic runs gate on a size preflight only — there is no high-context trigger, so a near-full context window is left to Pi's own compaction unless the removable surface is itself large:

- **Next-request:** ~20k removable tokens, or ≥40 removable entries and ≥10k removable tokens.
- **Live:** ~50k removable tokens, or ≥100 removable entries and ≥25k removable tokens.

Manual `/memedit run` ignores the preflight.

## Cache and token accounting

Status output separates three cache-tail quantities:

- **stable prefix** — context before the first deleted entry, expected to stay cache-reusable;
- **invalidated tail** — every active-context token from the first deletion onward;
- **kept tail** — the part of that tail that survives deletion and must be re-written/re-cached.

Deleting 52k tokens can rewrite only ~1.3k kept-tail tokens when nearly everything after the first deletion is removed. The status line reports invalidated, dropped, and rewritten tokens separately.

Prune calls use `cacheRetention: "none"`, since their transcript is ephemeral and should not pay cache-write premiums. Because the analysis is cheap (it reads the already-cached conversation and only appends a candidate index), applying a deletion is a separate, marginal decision gated on profitability: a deletion invalidates the cache tail after it, so the kept tail is re-written once at the cache-write rate while the deleted tokens stop being re-read on every later request. memedit applies a deletion set only when that one-off recache pays back within the cache's remaining life — `breakEvenCalls = recacheCost / savingPerCall ≤ E`, where `E = min(25, calls-until-auto-compaction)`. The constant 25 is the median remaining provider requests measured across session history (conversation length is heavy-tailed, so remaining requests are roughly flat by age); the compaction term only caps the horizon near the context ceiling, where Pi's compaction would evict the pruned region anyway. Within an accepted set memedit also picks the most profitable first-deletion point, declining early low-value deletions that would invalidate a large kept tail.

OpenAI-family models use `js-tiktoken` (`o200k_base`/`cl100k_base`) for local text-token estimates; other providers use Pi's conservative fallback estimate, while provider-reported usage gives the actual prune-pass cost.

## Commands

- `/memedit status` — show settings and last run.
- `/memedit run` — run a pass manually.
- `/memedit on` / `/memedit off` — toggle automatic pruning (persisted).
- `/memedit live on` / `/memedit live off` — toggle live continuation pruning (persisted).
- `/memedit show-deleted on` / `/memedit show-deleted off` — toggle removed-item previews in status output (persisted).

## Environment

- Settings persist at `~/.pi/agent/memedit/settings.json`; `PI_MEMEDIT_SETTINGS=/path/to/settings.json` overrides that path.
- `PI_MEMEDIT` / `PI_MEMEDIT_ENABLED` force memedit on or off at startup, overriding the persisted setting (`off`/`false` disable, `on`/`true` enable).
- `PI_MEMEDIT_DISABLE=1` forces memedit off at startup.

Anthropic OAuth (`sk-ant-oat…`) prune calls run through a provider-payload shaping callback that prepends the Claude Code billing header those requests expect. The transcript is sent as plain text, so historical tool calls/results are never serialised as Anthropic `tool_use` blocks.
