---
name: improve-skill
description: "Improve a skill's results on known benchmark cases over several rounds, with held-out cases confirming the gains, and keep the skill as instructions. Use when a skill should do better on specific cases, especially slow, noisy or expert-judged ones."
---

# Improve a skill

## What a skill contains

A skill is instructions: what to do, when, and how to check it was done. Each instruction is an action, scoped to the
situations it applies to.

- **No findings.** Statistics, percentages, sources and claims about what people do ("70% of maintainers ask for X",
  "reviewers flag Y twice as often") do not go in the skill or in any file it loads. Turn a finding into the
  instruction it implies, scoped to its situation ("When a change does Y, do X"), and keep the instruction only if
  the benchmark shows it changes results.
- **Evidence stays with the run.** Scores, per-case results, the reasons behind each change and `notes.md` are for
  whoever improves the skill next, not for the agent using it.
- **Examples are fine** when they show how to do the thing: a worked case or a real piece of work done well, as a
  reference the skill points to.

## Rounds

A driver script repeats rounds. Each round the task model does the bulk of the work, running the cases and explaining its own mistakes. Then a new reviewer session on the strongest model decides whether the last change helped and makes the next one. Reviewer sessions do not carry context from round to round; `notes.md` does.

The roles go to different model families. A Claude Opus model does the oversight, the grading and all the writing: verdicts, judge or grader sessions, `notes.md` and every edit to the skill. GPT-6.1-sol does the legwork: trials, follow-up explanations and bulk investigation. Sol sessions never edit the skill or `notes.md`; their output is evidence for the reviewer. Do not use older Sol models such as `gpt-6-sol`.

### A round

1. **Trials.** Run every training case once with the candidate skill. After a run is scored, copy its output so it stays as scored, then send the same agent session a follow-up with the reference. It knows why it made each choice. Ask it to compare its output with the reference item by item, trace each difference to the evidence, and classify each cause: skill missing, wrong or unclear; skill ignored; slip; evidence ambiguous or a legitimate judgement; reference error. It should quote the files, rows and skill passages that show it, in under 600 words.
2. **Review.** Start a new reviewer session. It reads `notes.md`, the round's scores beside the best version's, and the agents' findings, investigates, writes its verdict, edits the skill and adds to `notes.md`. See [the reviewer's steps](#reviewing-a-round).
3. **Holdout.** When the verdict is "improved", run the held-out cases and compare their aggregate scores with the best version's. Not worse: the candidate becomes the best version. Worse: return to the best version and record that in `notes.md`.

With no run record yet, the first round runs the unchanged skill to obtain one, and runs the holdout once. Whoever starts the run sets when it stops, for example after a number of kept improvements, in the brief the reviewers read. A reviewer can stop earlier when `notes.md` shows nothing more is worth trying.

### Setting up the driver

These are the usual ways a fresh setup goes wrong.

- **Models.** Name the exact provider/model and effort for each role in the driver's configuration, and pass them when each session is created: the task model on `openai-codex/gpt-6.1-sol` at `xhigh`, and the reviewer and any grader on a Claude Opus model such as `anthropic/claude-opus-5-5`. Keep Opus to review and grading; run trials and follow-ups on Sol. Create sessions directly, with the agent SDK or headless `pi` and its model and thinking options. Do not rely on a session spawning subagents with a model override, which asks a person for approval. Check that both providers are authenticated before the first round. Headless `pi` started with `--no-extensions` also drops the Claude sign-in extension, and Claude sessions then fail as "out of extra usage"; load it back with `-e` or keep extensions on.
- **Unattended.** Nothing may wait for a person. Before the first round, run one short session of each role headless and confirm it finishes on its own.
- **No artificial limits on the agents.** A trial agent gets what a user's session would: its normal tools and extensions, internet access and web search, and the usual time and output limits. Removing these measures a different agent from the one you are improving. The one restriction is what it can read. A trial sees its own case inputs and the skill, never the reference or another case's files. The reference reaches it only in the follow-up, after its output has been copied.
- **The reviewer has broad access.** It can read all training cases, references, run folders and the agents' findings, open and recalculate workbooks, run scripts and use the internet. Held-out cases are off limits. The driver gives it holdout aggregates only, and it must never open holdout inputs, outputs or per-case results.
- **Scores count decisions, not closeness.** An output is right or wrong on each point the evidence decides; points of genuine judgement accept any defensible treatment. A figure that is nearly right usually hides one wrong decision.
- **Records.** Keep every skill version (with a hash), its runs and scores. Resume interrupted trials instead of rerunning them. Run trials and follow-ups in parallel up to the machine's and provider's limits.

### Reviewing a round

You are a fresh reviewer. Work from the files, not from memory of earlier rounds.

1. Read `notes.md`: what has been tried, the evidence, the results, and ideas judged not worth trying.
2. Compare this round's scores with the best version's, case by case. Each case ran once, and a single run can differ from the last by chance, so judge by mechanism as well as score: did the decisions the change targeted actually change, for the reason intended, and did anything else change? The agents' findings show this. Write the verdict to `review.json`: `improved`, `not improved` or `baseline`, with reasons. Count a change as improved only when the targeted decisions improve and no variant of the skill gets worse.
3. Read the agents' findings. Check against the files any finding that will drive a change; an agent can rationalise its own choices.
4. Look for patterns across cases and runs. A cause seen once is an anecdote; one seen in several cases, or in most runs of one case, is worth a change. Note what the agent already gets right, so a change does not disturb it.
5. Choose one change and its form: guidance text, a worked example, a script or check the agent runs, or a template fix. Prefer the form that removes the error mechanically. Scope a rule to the facts that decide it and say what it does not cover; a broad rule drawn from one case is the usual way a fix breaks other cases. Do not retry an idea `notes.md` records as failed unless you change what made it fail.
6. Edit the skill copy the driver gives you (the candidate if your verdict is "improved", otherwise the best version) and validate it with the skill's tests and checks. The edit is an instruction, not a finding (see [what a skill contains](#what-a-skill-contains)); the evidence for it goes in `notes.md`.
7. Add to `notes.md`: the verdict, the evidence for your change, the change, and which results it should move. Keep entries short; later reviewers read the whole file. Set `stop` in `review.json` if nothing more is worth trying.

## Finish

Report the changes kept, per-case results before and after, the holdout aggregates, what was tried and failed, and the next most promising ideas. Hand the diff to the skill's owner for release.
