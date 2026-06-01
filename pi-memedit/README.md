# pi-memedit

Pi extension that runs automatic memory-edit passes over low-value conversation history.

It calls the current model directly with a dedicated pruning prompt and a text transcript of eligible conversation entries. Only entries tagged with compact temporary `[N]` identifiers are removable; `[context]` entries are context only and cannot be selected. Selected entries are hard-deleted from both future model context and the persisted session JSONL.

User messages, compaction summaries, and the freshest unsafe-to-delete assistant/tool-result tail are protected. The pruning request and response are not appended to model context. Status messages are also filtered out of future model context.

## Pruning modes

- **Next-request pruning** runs before the next user request is sent to the model. The pruning agent receives the user's next request so it can keep what the upcoming work will need.
- **Live continuation pruning** is enabled by default. During long agent runs, pi-memedit may prune after a completed tool-using turn once there is substantial older current-run material: about 50k removable tokens, or at least 100 removable entries and 25k removable tokens. It does not run after a final assistant answer. The just-finished turn is protected because the main agent has not consumed the tool results yet. Live pruning uses a continuation-specific prompt and only shows the current run, which keeps the pruning prompt smaller and avoids waiting until a single run has accumulated 100+ messages.

## Cache and token accounting

The status output now separates three quantities that used to be collapsed into the misleading “re-caches X tokens” line:

- **stable prefix** — context before the first deleted entry, expected to remain cache-reusable;
- **invalidated tail** — all active-context tokens from the first deleted entry onward;
- **kept tail rewrite** — the subset of that invalidated tail that remains after deletion and must be rewritten/re-cached.

A prune can delete 52k tokens and rewrite only 1.3k kept-tail tokens if almost everything after the first deletion was removed. The status line now makes that explicit by reporting invalidated, dropped, and rewritten tokens separately.

Break-even now includes both the one-off kept-tail rewrite cost and the actual pruning call cost. Automatic pruning is preflighted before spending the prune call and skipped when even the best case cannot pay back quickly enough, unless the context window is nearly full. Prune calls use `cacheRetention: "none"` because their transcript is ephemeral and should not pay cache-write premiums. Once the prune call has been paid, selected deletions are applied instead of being rejected by a second profitability check. OpenAI-family models use `js-tiktoken` (`o200k_base`/`cl100k_base`) for local text-token estimates; other providers still use Pi's conservative fallback estimate while relying on provider-reported usage for actual prune-pass cost.

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
