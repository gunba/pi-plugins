# pi-memedit

Pi extension that runs an automatic memory-edit pass after each agent turn.

It calls the current model directly with the current conversation and current system prompt, but only prefixes removable items from the just-finished agent run with compact temporary `[N]` identifiers. Untagged earlier history and protected current-run content are context only and cannot be selected. Selected entries are hard-deleted from both future model context and the persisted session JSONL.

The system prompt and user messages are protected. The pruning request and response are not appended to conversation context. A small visible status message is added after each auto run showing candidate, selected, ignored, and deleted counts; those status messages are filtered out of future model context.

## Commands

- `/memedit status` — show last run.
- `/memedit run` — run manually.
- `/memedit on` / `/memedit off` — toggle for the current process.

## Environment

- `PI_MEMEDIT=off` or `PI_MEMEDIT_ENABLED=false` disables on startup.
- `PI_MEMEDIT_DISABLE=1` disables on startup.
