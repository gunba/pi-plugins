# pi-tab-title

Auto-names the terminal tab for interactive Pi sessions and keeps the tab title synced with agent state.

## Behaviour

- On a fresh session, the terminal title starts with `○` and a cwd-based fallback.
- After the first user message, the extension asks a cheap same-provider model for a 20-30 character title and stores it in the session.
- While the agent is working, the title pulses through `·`, `•`, and `●`.
- After a successful turn, the title switches to `✓`.
- If a provider, assistant, or tool error is observed, the title switches to `✗` until the next turn starts.

The terminal title is updated through Pi's `ctx.ui.setTitle()`, which uses the terminal window/tab title mechanism supported by common terminal emulators.

## Model choice

The naming request stays on the current provider. It prefers provider-specific cheap models where available, such as OpenAI nano/mini models, Codex mini/spark models, Anthropic Haiku, and Gemini Flash Lite. If no same-provider model is available or the naming call fails quickly, it falls back to a local keyword title instead of blocking the main agent.
