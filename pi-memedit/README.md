# pi-memedit

Pi extension that runs an automatic memory-edit pass after each agent turn.

It calls the current model directly with a dedicated pruning prompt and a text transcript of the current conversation, but only prefixes removable items from the just-finished agent run with compact temporary `[N]` identifiers. Untagged earlier history and protected current-run content are context only and cannot be selected. Selected entries are hard-deleted from both future model context and the persisted session JSONL.

The system prompt and user messages are protected. The pruning request and response are not appended to conversation context. While a prune call is running, a temporary UI line is shown so the terminal does not look frozen. A small visible status message is added after each auto run showing candidates, selected, ignored, deleted, active-context reduction, and the cache calculus: the one-off cost to re-cache the tail invalidated past the first deletion versus the per-turn cache-read saving from the removed tokens, expressed as a break-even number of future turns, plus the prune-call's own token/cost overhead. Those status messages are filtered out of future model context. Removed item previews can be shown in that status message when enabled.

## Commands

- `/memedit status` — show settings and last run.
- `/memedit run` — run manually.
- `/memedit on` / `/memedit off` — toggle automatic pruning and persist the setting.
- `/memedit show-deleted on` / `/memedit show-deleted off` — toggle removed item previews in status output and persist the setting.

## Environment

- Settings persist at `~/.pi/agent/memedit/settings.json` by default.
- `PI_MEMEDIT_SETTINGS=/path/to/settings.json` overrides the settings file path.
- `PI_MEMEDIT=off` or `PI_MEMEDIT_ENABLED=false` disables on startup.
- `PI_MEMEDIT_DISABLE=1` disables on startup.
- `PI_SUBAGENT_CHILD=1` disables memedit automatically so pi-subagents child sessions are never pruned.

Anthropic OAuth (`sk-ant-oat...`) prune calls use a provider-payload shaping callback that adds the Claude Code billing header expected by Anthropic OAuth requests. The prune transcript is sent as plain text, so historical tool calls/results are not serialized as Anthropic `tool_use` blocks.
