# pi-memedit

Pi extension that runs automatic memory-edit passes over low-value conversation history.

It calls the current model directly with a dedicated pruning prompt and a text transcript of eligible conversation entries. Only entries tagged with compact temporary `[N]` identifiers are removable; `[context]` entries are context only and cannot be selected. Selected entries are hard-deleted from both future model context and the persisted session JSONL.

Only entries this live session generated are eligible: everything present when the session was resumed or restarted is frozen as context, and once a pass has judged an entry it is never re-offered (it stays in context, but out of candidacy). Eligibility is decided by entry identity, not by a positional boundary into the log. User messages, compaction summaries, and the freshest unsafe-to-delete assistant/tool-result tail are protected. The pruning request and response are not appended to model context. Status messages are also filtered out of future model context.

## Pruning modes

- **Next-request pruning** runs before the next user request is sent to the model. The pruning agent receives the user's next request so it can keep what the upcoming work will need. When a pass is skipped for too little material, its entries simply stay unjudged and accumulate with later ones until a pass is worthwhile.
- **Live continuation pruning** is enabled by default. During long agent runs, pi-memedit may prune after a completed tool-using turn once there is substantial older unjudged material: about 50k removable tokens, or at least 100 removable entries and 25k removable tokens. It does not run after a final assistant answer. The freshest turn is protected because the main agent has not consumed the tool results yet. Live pruning uses a continuation-specific prompt and only shows the session's not-yet-judged entries, which keeps the pruning prompt smaller and avoids waiting until a single run has accumulated 100+ messages.

## Cache and token accounting

The status output separates three cache-tail quantities:

- **stable prefix** — context before the first deleted entry, expected to remain cache-reusable;
- **invalidated tail** — all active-context tokens from the first deleted entry onward;
- **kept tail rewrite** — the subset of that invalidated tail that remains after deletion and must be rewritten/re-cached.

A prune can delete 52k tokens and rewrite only 1.3k kept-tail tokens if almost everything after the first deletion was removed. The status line reports invalidated, dropped, and rewritten tokens separately.

Automatic pruning uses size preflight only: normal auto pruning waits for roughly 20k removable tokens, or 40 removable entries and 10k removable tokens; live pruning waits for roughly 50k removable tokens, or 100 removable entries and 25k removable tokens. There is no high-context override. High context usage is left to Pi's normal auto-compaction unless the removable surface itself is large enough.

Prune calls use `cacheRetention: "none"` because their transcript is ephemeral and should not pay cache-write premiums. Once the prune call has been paid, selected deletions are applied instead of being rejected by a second profitability check. OpenAI-family models use `js-tiktoken` (`o200k_base`/`cl100k_base`) for local text-token estimates; other providers still use Pi's conservative fallback estimate while relying on provider-reported usage for actual prune-pass cost.

## Commands

- `/memedit status` — show settings and last run.
- `/memedit run` — run manually.
- `/memedit on` / `/memedit off` — toggle automatic pruning and persist the setting.
- `/memedit live on` / `/memedit live off` — toggle live continuation pruning and persist the setting.
- `/memedit show-deleted on` / `/memedit show-deleted off` — toggle removed item previews in status output and persist the setting.

## Environment

- Settings persist at `~/.pi/agent/memedit/settings.json` by default.
- `PI_MEMEDIT_SETTINGS=/path/to/settings.json` overrides the settings file path.
- `PI_MEMEDIT=off` or `PI_MEMEDIT_ENABLED=false` disables on startup.
- `PI_MEMEDIT_DISABLE=1` disables on startup.
- `PI_SUBAGENT_CHILD=1` disables memedit automatically so pi-subagents child sessions are never pruned.

Anthropic OAuth (`sk-ant-oat...`) prune calls use a provider-payload shaping callback that adds the Claude Code billing header expected by Anthropic OAuth requests. The prune transcript is sent as plain text, so historical tool calls/results are not serialized as Anthropic `tool_use` blocks.
