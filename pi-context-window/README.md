# Context window

`/context-window` opens a dialog for the selected model. It shows Pi's
current context window, the automatic checkpoint threshold, and these choices:

- **Set a token budget:** enter an exact window size. `/context-window 272000`
  sets the same budget directly, preserving the model's response reserve.
- **Pi catalog:** remove this model's window and checkpoint overrides.
- **1M / 900K:** use a 1,000,000-token model window and checkpoint around
  900,000 tokens. This opt-in appears only for supported OpenAI models.

The larger setting applies to the active model only. It writes
`providers.<provider>.modelOverrides.<model>.contextWindow` to
`~/.pi/agent/models.json` and a model-specific `reserveTokens` to
`~/.pi/agent/settings.json`. Other model and provider settings are preserved.
Pi refreshes the selected model and reloads its settings after a change;
other running Pi sessions should `/reload` before using the new limit.

On ChatGPT-backed Codex sessions, Pi's automatic compaction trigger invokes
the native Codex checkpoint through `pi-codex-wire`; this modal does not
enable Pi's prose summarizer. An API model's published 1.05M capacity and
Pi's configured window are different numbers. A larger window can use more
quota, and an endpoint can still enforce a lower limit.

Pi Desk shows usage as a bar against the model capacity, with a marker for
the selected budget. Click the bar or open Settings → Context capacity to
adjust the slider or enter a token count, then apply it. Changes are not sent
while dragging. Built-in model capacity comes from Pi's catalog; the supported
extended OpenAI models also expose their larger window.

Pi Desk's native
compaction control remains in the conversation settings. Terminal and web choices
share the same configuration reader and writer. A changed model/session or a
concurrent change to this model's saved preset rejects the pending save.
The dialog never changes unrelated models, credentials, workspace overrides,
or the automatic-compaction policy.
