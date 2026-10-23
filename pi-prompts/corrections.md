---
description: Find where Jordan keeps correcting agents, and propose fixes
argument-hint: "[days]"
---
Find the places where Jordan had to correct agents over the last ${1:-7} days, and propose fixes that would stop the
same corrections recurring. Don't change any file: report first.

1. Collect Jordan's messages from conversations on this computer modified in that period: the `.jsonl` files under
   `~/.pi/agent/sessions/`. Take entries of type `message` whose `message.role` is `user`, with their text, and for
   each keep the agent's text reply just before it, the conversation's title or first message, its folder and the
   date. Skip conversations whose folder is under `/tmp`, and messages that only carry files or images. Do this with
   a script; don't read the files into the conversation.
2. Screen every message with System One's Jev through codemode's `models.classify` (`typesafe`, `jev-latest`, or
   another available classifier). Give it the message and the reply before it, and ask:
   - `correction` (bool): Is Jordan correcting the agent? For example, pointing out a mistake, repeating an
     instruction it ignored, undoing or overruling its choice, or objecting to how it worked.
   - `kind` (choice): `ignored-instruction`, `wrong-assumption`, `poor-quality`, `too-verbose-or-unclear`, `too-slow`,
     `unsafe-or-unwanted-action`, `other`.

   Keep the messages with a probability above 0.5. Run the calls in parallel.
3. Read each flagged message in its context (a few entries either side) to confirm it really is a correction and to
   see what the agent did. Drop false positives.
4. Group the confirmed corrections into patterns: the same kind of mistake, across conversations or repeated within
   one. Ignore one-offs.
5. For each pattern, propose the smallest fix that would prevent it, and say where it goes. A fix can be:
   - a line in `~/.pi/agent/AGENTS.md` (all conversations), or in a project's `AGENTS.md`;
   - a change to a skill;
   - a change to a plugin or tool.

   Check whether existing instructions already cover it: if so, say why they didn't work instead of repeating them.

Report in plain English, most frequent pattern first. For each pattern, give:
- how often it happened, and in which conversations;
- one or two of Jordan's own words as examples, with dates;
- the fix, with its exact wording or change.

End with how many messages were screened, flagged and confirmed.
