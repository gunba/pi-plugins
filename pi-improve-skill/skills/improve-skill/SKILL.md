---
name: improve-skill
description: "Improve an agent skill against benchmark cases. One session on the strongest model runs trials of the task model, has each trial agent reconcile its own output against the reference, edits the skill (text, scripts, templates) and confirms gains on held-out cases. Use when a skill's results on known cases should get better, especially when runs are slow, noisy or need expert judgement to assess."
---

# Improve a skill

You run the improvement loop yourself. The task model does the bulk of the work: it runs the trials, and afterwards each trial agent explains its own mistakes. You spend your effort on causes, changes and decisions.

## Before you start

You need:

- **Cases**: inputs a practitioner had and the reference result they produced, with the evidence to reach it. A difference caused by missing evidence cannot be fixed by the skill.
- **A trial command** that runs chosen cases N times with a given skill folder and returns each run's score and output folder (outputs, steps, final message), and a way to send a finished trial agent a follow-up message in its own session.
- **A holdout command** that runs held-out cases with a skill folder and prints only aggregate scores. Never open holdout inputs, outputs or per-case results; they exist to tell you whether a change generalises.
- **A working copy** of the whole skill (instructions, references, scripts, templates) and a way to validate it (its tests, linters, template checks). Make sure scripts are current before you begin.
- **A score that counts decisions, not closeness.** An output is right or wrong on each point the evidence decides; points of genuine judgement accept any defensible treatment. A figure that is nearly right usually hides one wrong decision.

Ask for any of these that is missing rather than improvising it.

## Baseline

Run every training case several times with the unchanged skill to see each case's spread, and run the holdout once. A difference smaller than a case's run-to-run spread is not evidence. Record the baseline in `journal.md`.

## Loop

1. **Investigate.** After a run's output is saved and scored, send the trial agent a follow-up in its own session with the reference. It knows why it made each choice, which a fresh reader would have to reconstruct. Ask it to:
   - compare its output with the reference item by item and trace each difference to the evidence;
   - classify each cause: skill missing, wrong or unclear; skill ignored; slip; evidence ambiguous or a legitimate judgement; reference error;
   - quote the files, rows and skill passages that show it, and report in under 600 words.
   Ask further questions the same way. The follow-up cannot change the scored output. An agent can rationalise its own choices, so check the findings that will drive a change against the files yourself. Where a session cannot be resumed, start a fresh investigator with `spawn_agent` on the task model (the first model override needs the user's approval once).
2. **Find patterns.** Look across cases and runs. A cause seen once is an anecdote; a cause seen in several cases, or in most runs of one case, is worth a change. Note what the agent already gets right, so a change does not disturb it.
3. **Choose one change and its form.** Guidance text, a worked example, a script or check the agent runs, or a template fix. Prefer the form that removes the error mechanically. Scope a rule to the facts that decide it and say what it does not cover. A broad rule drawn from one case is the usual way a fix breaks other cases. Write down which results should change.
4. **Edit the working copy** and validate it.
5. **Test.** Re-run the cases the change targets, plus a regression set that covers every variant the changed file serves. Shared method files reach every variant; a variant-specific guide reaches only its own. Run variants side by side so one change is tested everywhere in the same round. Have the trial agents explain any result that moved, in either direction.
6. **Keep or revert.** Keep the change when the targeted results improve beyond noise and nothing else gets worse. Otherwise revert it and record why.
7. **Check the holdout** after a few kept changes and before finishing. Steady or better: the changes stand. Worse: revert to the last version whose holdout held, and look again at the changes since.

## Journal

Keep `journal.md` beside the working copy: baseline, then for each change the evidence behind it, the prediction, the runs, the result and the decision. Read it before each new change, and do not retry a failed idea unchanged.

## Compute

Run trials and follow-ups in parallel up to the machine's and provider's limits. Read the agents' reconciliations rather than raw outputs, except to verify a finding. Resume interrupted runs rather than restarting them.

## Finish

Report the changes kept, with per-case results before and after, the holdout aggregates, what was tried and failed, and the next most promising ideas. Hand the diff to the skill's owner for release.
