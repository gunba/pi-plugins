# Pi Effort

Automatic effort for Claude conversations. The reasoning level you set is the conversation's level and the most it
uses. A stretch of work (everything the agent does from one arrival until it stops) may start up to two levels lower
when what arrived looks lighter than the conversation's hardest work, and climbs back as the run shows its size. It
never goes below medium, so a setting of medium or less is left alone.

It is off unless switched on.

## Use

- `/effort on` and `/effort off` switch it for this conversation; `/effort follow` goes back to the computer's default.
- `/effort default on` and `/effort default off` set the default for this computer (`pi-effort.json` in Pi's folder).
- `/effort` says where it stands.
- In Desk, the sliders button beside the reasoning level switches it for the conversation. While it is on, the level
  shown is the one you chose, with the level in use beside it when that is lower.

Changing the reasoning level yourself always sets the conversation's level, also in the middle of a run.

## How a level is chosen

Where a stretch starts:

- You wrote something: a classifier (Jev, `typesafe/jev-latest`) rates your words on one scale. How much
  investigation, checking and judgement does this need, compared with the most demanding work you have asked for in
  this conversation? Clearly less starts one level down, far less two. As demanding, unclear, a result that fell short,
  or the conversation's first message starts at your level. The classifier reads only text you sent: the new message
  and your earlier ones, without attachments or tool output.
- Nothing of yours arrived (a watch, another agent, a plan round): there is nothing to rate, so it starts two down.
- The classifier is missing, slow or fails: your level.

How it climbs: at 8 steps or 2 edits, or when the agent makes a plan, the level goes up one. At 25 steps or 4 edits it
goes to your level. Steering is rated like any message and can only raise the level; at your level nothing more is
asked until the run ends. A follow-up queued behind a run starts a stretch of its own.

When the conversation is idle its level is the one you chose.

## Why only Claude, and only where a message arrives

Claude models that take an effort level inside the conversation (Pi's `supportsMidConvoEffort`) keep their prompt
cache when the level changes; other models lose it, so the extension does nothing with them. The provider applies a
new level from a turn with new input and not in the middle of a tool loop. A raise in the middle of a run therefore
adds one hidden line to the conversation (`pi-effort/raise`).

## What it records

- `pi-effort/state-v1`: this conversation's switch and your level, so a restart in the middle of a lowered run puts
  your level back.
- `pi-effort/log-v1`: one entry per decision (start, climb, steer, follow-up) with the level, the classifier's two
  answers and the run's size, for comparing levels with how the work turned out.

Other plugins read your level, not the level of the moment, through `effortSetting()` in `src/shared.ts`: helpers
inherit it, and a held compaction is not retried because the level moved.

## Development

```sh
npm run typecheck
```
