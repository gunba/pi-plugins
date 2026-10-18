# Code review

A `code-review` skill that teaches an agent to review a change the way top
maintainers do, built from what those maintainers actually wrote.

- [`skills/code-review`](skills/code-review/SKILL.md) is the skill: a
  procedure, a checklist of what to review for, verification rules and a
  comment format, with real comments from top reviewers as references and a
  script that searches them.
- [`mining`](mining/README.md) is the pipeline that built it. It mines review
  comments from 22 GitHub repositories, nine kernel.org mailing lists and Go's
  Gerrit, labels them with TypeSafe's Jev classifier, and builds the
  reference pools.
- [`bench`](bench) is the held-out benchmark. It covers 32 pull requests whose
  maintainers raised high-value points. It runs headless reviews with and
  without the skill, matches findings to the maintainers' comments with Jev,
  and has Claude Opus grade each finding against the code.

## The corpus

34,871 review comments on 4,399 changes in 35 projects, collected April 2025
to September 2026: LLVM, Rust, CPython, Kubernetes, OpenJDK, WebKit, systemd,
Wasmtime, TypeScript, Node.js, .NET, Tokio, Bitcoin Core, Envoy, Django,
NumPy, Swift, PyTorch, OpenSSL, DuckDB, Ruff and etcd on GitHub; linux-mm,
netdev, bpf, linux-fsdevel, rust-for-linux, io-uring, linux-block, kvm and git
on lore; and Go, x/tools, x/crypto and x/net on Gerrit.

Jev labelled who wrote each comment (reviewer, author or automation), what it
does, its topic, depth, severity and outcome, and the review move it makes.
A comment counts as *high-value* when it is deep, consequential and concrete,
and the author acted on it. Those comments, from the training split only,
decided what the checklist covers and in what order, and supply its examples.
[`references/corpus.md`](skills/code-review/references/corpus.md) has the
method, the label checks and the tables.

## Benchmark

Reviews ran on GPT-6.1-sol (high), two repetitions per condition, against
held-out PRs. Jev matched findings to the maintainers' landed comments; Claude
Opus 5.5 graded every finding against the code without knowing the
condition. *High-value* recall counts the maintainers' deep, consequential
points; *soft* recall averages Jev's match confidence and does not flip on
borderline matches.

Confirmation set: 24 PRs no version of the skill was tuned on.

| | Findings per review | Valid per review | Invalid | High-value recall | All landed points | Soft recall |
|---|---:|---:|---:|---:|---:|---:|
| No skill | 2.0 | 2.0 | 0% | 17/54 | 17/72 | 25.6% |
| Skill | 3.1 | 2.8 | 0% | 17/54 | 20/72 | 33.3% |

Development set: 32 PRs, used to choose between skill versions, so these
numbers are optimistic.

| | Findings per review | Valid per review | Invalid | High-value recall | All landed points |
|---|---:|---:|---:|---:|---:|
| No skill | 2.4 | 2.1 | 0.5% | 27/102 | 32/164 |
| Skill | 3.1 | 2.8 | 0% | 33/102 | 49/164 |

Without the skill, GPT-6.1-sol reports only the defects it is sure of, and
misses the points maintainers raise about existing mechanisms, missing test
cases, contracts and compatibility. With it, the model reports about 40% more
valid points at the same precision, and takes about 1.8 times as long. On
unseen PRs that lifts soft recall of what maintainers raised by 8 points; it
does not yet raise the count of the maintainers' high-value points found.

An earlier round on Claude Sonnet 5.5, a model that reports about ten
findings per review, showed the opposite failure: the judge found 17-19% of
its unaided findings wrong, and the skill cut that to 13%.

```sh
node bench/cases.mjs select && node bench/cases.mjs build 32   # after Jev answers "findable"
node bench/run.mjs --label base --model openai-codex/gpt-6.1-sol --thinking high
node bench/run.mjs --label skill --model openai-codex/gpt-6.1-sol --thinking high --skill skills/code-review
node bench/score.mjs prepare base skill        # then Jev: match.json and questions.json
node bench/judge.mjs --runs base,skill --model anthropic/claude-opus-5-5
node bench/score.mjs report base skill
```

Data and runs live in `~/.cache/pi-code-review`.
