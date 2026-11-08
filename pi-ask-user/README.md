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

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | `string` | required | The question to ask the user |
| `context` | `string?` | — | Relevant context summary shown before the question |
| `options` | `(string | {title, description?})[]?` | `[]` | Multiple-choice options |
| `allowMultiple` | `boolean?` | `false` | Enable multi-select mode |
| `allowFreeform` | `boolean?` | `true` | Add a freeform response option |
| `allowComment` | `boolean?` | `false` | Allow an optional comment after a structured choice |
| `timeout` | `number?` | — | Auto-dismiss after N ms |
| `done_when` | `string?` | — | For a request to do something: a shell command (the bash tool's shell) re-run every 5 s; the question closes by itself once it exits 0 |
| `wait` | `boolean?` | `true` | `false`: don't wait (Desk only). The call returns at once with the question's ID; the question stays open while the agent works, and the answer, or the user closing it, comes back as a `pi-ask-user/answer` message that joins the agent's run or starts a turn. Takes neither `done_when` nor `timeout`. |

A question asked without waiting is recorded in the conversation and asked again when the conversation restarts,
such as for a Desk update, so an answer given later still arrives. Desk shows it as "Question" beside the
conversation's activity, and doesn't count it as waiting on the user: the composer stays free, settings can change,
and stopping or interrupting a run leaves it open. It is asked again under its ID as key (pi-ui `UiQuestion.key`), so
it doesn't keep the conversation from sleeping either: while the conversation is closed in Desk's sidebar, Desk keeps
the question on screen, and an answer reopens the conversation and reaches the agent once the question is asked again.

In the terminal the question opens as an overlay. `PI_ASK_USER_DISPLAY_MODE=inline`
shows it in place instead. `alt+o` hides and reopens the overlay and `ctrl+g` toggles
the optional comment; `PI_ASK_USER_OVERLAY_TOGGLE_KEY` and
`PI_ASK_USER_COMMENT_TOGGLE_KEY` change those keys, or `off` disables them.

## Provenance

Forked from `pi-ask-user@0.11.2` by Enzo Lucchesi, MIT licensed. The UI implementation is intentionally kept close to upstream so behavior stays familiar.

This local fork does not load the upstream `ask-user` skill by default.
