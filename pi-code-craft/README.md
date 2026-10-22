# Code craft

Two skills that teach an agent what maintainers of top projects expect from
tests and from comments in code, built from what those maintainers wrote in
review.

- [`skills/test-writing`](skills/test-writing/SKILL.md): write tests that
  fail without the change, cover the cases that matter, assert exact results
  and pass on every machine; never weaken a test to get a green run.
- [`skills/code-comments`](skills/code-comments/SKILL.md): keep comments true
  after a change, write down contracts and reasons the code cannot show, and
  leave out narration of the change and comments that repeat the code.
- [`mining`](mining/README.md): the pipeline that built them. It mines review
  remarks from 48 GitHub repositories, eleven kernel.org mailing lists, and
  Go's and Chromium's Gerrit, including 1,986 pull requests written by coding
  agents, and labels them with TypeSafe's Jev classifier.
- [`bench`](bench): held-out benchmarks for both skills.

## The corpus

131,999 review units on 14,522 changes in 64 projects, April 2025 to
September 2026. Jev read the 46,005 that are on test files or mention tests or
comments, and found 17,354 remarks by people about tests and 8,624 about code
comments. It labelled each with the problem it raises (23 kinds for tests, 16
for comments), its depth, severity, concreteness and outcome. The skills'
figures and examples use the training split (85% of changes); the benchmark
uses the rest.

What it shows, for tests:

- Missing cases are 16% of test remarks but 29% of the ones that matter
  (deep, consequential, concrete and acted on). Loose assertions, assumptions
  about the machine, tests that pass without the change and flaky tests are
  each 1.7 to 2 times as common among those as overall.
- Simplification, helper reuse, duplication and naming are 27% of test
  remarks and 8% of the ones that matter.
- On agent-written changes, reviewers flag assumptions about the machine
  twice as often as on people's changes in the same projects, weakened or
  removed tests 1.75 times as often, and bugs in the test code 1.4 times.

For comments:

- A third of the remarks that matter point at a comment that is wrong; the
  next largest group asks for an unwritten contract (concurrency, ownership,
  preconditions) to be written down.
- On agent-written changes, reviewers object 5.5 times as often to comments
  that narrate the change, and about twice as often to comments that repeat
  the code or run long. They ask agents to explain *why* half as often as
  they ask people.

`docs/` has the method, label checks and tables: `tests.md`, `comments.md`
and `agents.md`. The skills themselves contain only instructions.

## Benchmarks

Trials ran on GPT-6.1-sol (high), one run per case and condition, on changes
from the holdout split.

### Test writing

18 Go changes (gRPC-Go, Prometheus, etcd, Go tools and crypto) that came with
tests and drew test remarks. Each case is the repository with the change's
source applied and its tests removed; the agent writes the tests. Scoring runs
them with the change (three times), with the change reverted, and with each
source hunk reverted on its own. A blind Claude Opus judge compares the two
conditions' tests against the maintainers' own tests and remarks.

| | Pass on the change | Fail without it | Hunk reverts caught by an assertion | Judge prefers | Accept as is | Should-fix problems | Minutes | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| No skill | 17/18 | 17/18 | 34% | 6 | 3 | 31 | 4.1 | $3.07 |
| Skill | 16/18 | 16/18 | 35% | 12 | 6 | 22 | 5.8 | $4.55 |
| Maintainers' tests | 17/18 | 17/18 | 27% | | | | | |

The judge's scores (1 to 5) with the skill against without: assertions 4.78
against 4.50, fit with the project 4.11 against 3.72, clarity 3.72 against
3.28, cases 4.50 against 4.72, reliability 4.17 against 4.28.

The model already writes tests that fail without the change; the skill does
not change that. It makes the tests tighter and more in the project's style,
for about 40% more time. The failures on the change itself are findings, not
broken tests. In x/tools 763920 the agent with the skill wrote a case the
maintainers' test missed, kept it failing and reported it: the change does not
zero an omitted outer field when a struct literal sets promoted fields. Go's
compiler does, and the test passes on current x/tools, which has since fixed
it. In etcd
20564 both conditions found that cache reads between two snapshots return a
later write. Twelve to six over 18 cases is a signal, not proof.

### Code comments

20 pull requests at the commit where a maintainer raised a comment problem
that was then fixed. The agent checks and fixes the change's comments before
review; a blind Claude Opus judge checks each maintainer remark and rates
every edit.

| | Judge prefers | Maintainer remarks fixed | Partly | Harmful edits |
|---|---:|---:|---:|---:|
| No skill | 6 | 14/40 | 5 | 2 |
| Skill, first version | 12 (2 ties) | 16/40 | 8 | 10 |
| No skill (second judging) | 6 | 12/36 | 5 | 0 |
| Skill, current version | 10 (2 ties) | 14/36 | 4 | 4 |

The first version deleted comments that carried a reason, a TODO link or
documentation the pull request existed to add. The current version keeps
information in other people's comments unless it is wrong, repeated or
narration. It still cuts more than no skill does, most of all on a pull
request whose purpose is documentation.

```sh
node bench/tests-cases.mjs
node bench/tests-run.mjs --label base --model openai-codex/gpt-6.1-sol --thinking high
node bench/tests-run.mjs --label skill --model openai-codex/gpt-6.1-sol --thinking high --skill skills/test-writing
node bench/tests-score.mjs --runs base,skill
node bench/tests-judge.mjs --runs base,skill
node bench/tests-report.mjs --runs base,skill

node bench/comments-cases.mjs 20
node bench/comments-run.mjs --label base
node bench/comments-run.mjs --label skill --skill skills/code-comments
node bench/comments-judge.mjs --runs base,skill
node bench/comments-report.mjs --runs base,skill
```

Data and runs live in `~/.cache/pi-code-craft`. Run the long steps as
separate services (`systemd-run --user`) and keep Go's build parallelism down
(`bench/go-env.mjs`): several trials building etcd or gRPC at once exhaust
memory.
