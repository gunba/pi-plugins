# pi-ask-user

Conservative local fork of `pi-ask-user@0.11.2` for the `pi-plugins` package.

This extension registers the interactive `ask_user` tool while avoiding mandatory decision-gate skill guidance. It is intended for cases where the agent needs explicit user input, not as a general prompt to ask before routine work.

## Guidance policy

Use `ask_user` sparingly:

- Ask when progress is blocked by a user-owned decision, missing permission, or a requirement that cannot be resolved from project context.
- Ask before destructive or hard-to-reverse actions when the user has not already approved them.
- Do not ask for details that can be discovered by reading files, running checks, or using available documentation.
- For low-risk reversible ambiguity, make a reasonable assumption, state it briefly, and continue.
- Ask one focused question per call.

## Tool

Registered tool name: `ask_user`.

Parameters match the vendored upstream extension:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | `string` | required | The question to ask the user |
| `context` | `string?` | — | Relevant context summary shown before the question |
| `options` | `(string | {title, description?})[]?` | `[]` | Multiple-choice options |
| `allowMultiple` | `boolean?` | `false` | Enable multi-select mode |
| `allowFreeform` | `boolean?` | `true` | Add a freeform response option |
| `allowComment` | `boolean?` | `false` | Allow an optional comment after a structured choice |
| `displayMode` | `"overlay" | "inline"?` | env var or `"overlay"` | UI rendering mode |
| `overlayToggleKey` | `string?` | env var or `"alt+o"` | Shortcut to hide/show the overlay prompt |
| `commentToggleKey` | `string?` | env var or `"ctrl+g"` | Shortcut to toggle the optional comment row |
| `timeout` | `number?` | — | Auto-dismiss after N ms |

## Provenance

Forked from `pi-ask-user@0.11.2` by Enzo Lucchesi, MIT licensed. The UI implementation is intentionally kept close to upstream so behavior stays familiar.

This local fork does not load the upstream `ask-user` skill by default.
