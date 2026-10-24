# The corpus

## Sources

| Source | Projects | Changes |
|---|---|---:|
| GitHub pull requests | LLVM, Rust, CPython, Kubernetes, OpenJDK, WebKit, systemd, Wasmtime, TypeScript, Node.js, .NET runtime, Tokio, Bitcoin Core, Envoy, Django, NumPy, Swift, PyTorch, OpenSSL, DuckDB, Ruff, etcd, pytest, CockroachDB, Prometheus, Cargo, VS Code, Angular, ClickHouse, Kafka, scikit-learn, pandas, mypy, curl, Neovim, containerd, rust-analyzer, Vitest, Arrow, gRPC-Go, Deno; and the agent-written pull requests below | 11,405 |
| kernel.org mailing lists (lore) | linux-kselftest (selftests and KUnit), fstests, git, linux-mm, netdev, bpf, linux-fsdevel, rust-for-linux, io-uring, linux-block, kvm | 2,242 |
| Gerrit | Go (go, tools, crypto, net) and Chromium | 1,115 |

Agent-written pull requests: 1,514 by GitHub's Copilot coding agent (in the
.NET runtime, ASP.NET Core, Roslyn, MAUI, the .NET SDK, EF Core, VS Code,
TypeScript-Go and the Azure SDK for .NET) and 472 whose description carries
Claude Code's signature, from the projects above. Eight Codex pull requests
were found, too few to use.

GitHub changes are a random sample of closed pull requests created between
April 2025 and September 2026 with at least three review threads (two for
agent-written ones), at most 40 files and 3,000 changed lines. Rejected changes
are included. Lore changes are patches someone other than the author replied
to, spread over each list's most recent 30,000 messages. Gerrit changes are
merged or abandoned changes in the same window with at least four comments;
Chromium's are drawn from two days in each month.

A *review unit* is one reviewer comment with the code it was on and the replies
that followed: a GitHub review thread or review-level comment, one inline reply
block in a review email, or a Gerrit comment thread. There are 131,999.

## Labels

Units on test files, or that mention tests or code comments, 46,005 in all,
went to Jev, TypeSafe's classifier (`mining/code-craft/questions.json`). It labelled:

- **speaker**: reviewer, author or automation (bots, AI reviewers, and people
  pasting AI reviews). A person instructing a coding agent is a reviewer.
- **subject**: test code, test coverage, a code comment, or something else;
- **kind**: finding, suggestion, question, nit, ack or process;
- **depth** and **severity** (0 to 3), **concrete** (yes or no);
- **outcome**: accepted, explained, rejected, deferred or unknown, from the
  replies and GitHub's *outdated* and *resolved* signals, Gerrit's resolution
  and later patch sets, and a later version of a kernel patch.

The 17,354 remarks people made about tests then got a second label: which of
23 problems they raise (`mining/code-craft/test-moves.json`). The 403 rejected remarks on
tests or comments with an author reply got the author's reason
(`mining/rebuttal.json`).

A remark is **high-value** when a person wrote it, it is a finding,
suggestion or question, depth is at least 1.5, severity at least 1.5 (a
real defect could ship unnoticed, or the test fails at random), it is concrete,
and it landed: accepted, likely accepted from the signals, or followed by a new
version of a kernel patch.

## Checks on the labels

A random sample of 40 first-pass labels and 48 problem labels was read by
hand. About four in five problem labels were clearly right; most of the rest
were defensible neighbours (a missing case labelled as a request for a test,
an unclear comment labelled as wrong). The first pass labelled people
instructing Copilot as automation; the speaker question was reworded before
the full run.

## What the data shows

All figures are from the training split (85% of changes). *Share* is the
problem's share of the 12,820 substantive test remarks (findings, suggestions
and questions); *high-value* is its share of the 2,264 high-value ones; *lift*
is the ratio of the two.

| Problem | Share | High-value | Lift | Landed | Rejected |
|---|---:|---:|---:|---:|---:|
| missing_case | 15.7% | 29.2% | 1.86 | 71% | 1.8% |
| weak_assertion | 5.5% | 9.3% | 1.69 | 82% | 2.3% |
| test_logic_bug | 7.1% | 9.0% | 1.27 | 82% | 1.2% |
| environment_assumption | 4.7% | 8.3% | 1.77 | 64% | 4.3% |
| needs_test | 7.5% | 6.4% | 0.85 | 59% | 2.3% |
| not_discriminating | 3.4% | 5.8% | 1.71 | 64% | 2.3% |
| flaky | 2.9% | 5.7% | 1.97 | 64% | 3.5% |
| reuse_test_infra | 8.2% | 5.1% | 0.62 | 80% | 3.3% |
| wrong_expectation | 3.0% | 4.0% | 1.33 | 73% | 0.9% |
| isolation_cleanup | 2.5% | 3.4% | 1.36 | 77% | 1.5% |
| weakened_or_removed | 3.1% | 2.8% | 0.90 | 68% | 2.6% |
| unrealistic_setup | 1.3% | 1.6% | 1.23 | 62% | 6.3% |
| overspecified | 2.0% | 1.4% | 0.70 | 76% | 3.8% |
| placement_naming | 4.1% | 1.3% | 0.32 | 83% | 2.8% |
| implementation_coupling | 1.3% | 1.1% | 0.85 | 78% | 3.5% |
| duplicate_or_parametrize | 5.4% | 1.0% | 0.19 | 78% | 2.7% |
| different_technique | 0.8% | 0.9% | 1.13 | 59% | 2.3% |
| simplify_reduce | 9.7% | 0.8% | 0.08 | 81% | 2.4% |
| explain_test | 4.6% | 0.6% | 0.13 | 56% | 2.4% |
| cost | 1.5% | 0.6% | 0.40 | 66% | 1.9% |
| mocking | 0.5% | 0.6% | 1.20 | 77% | 0% |
| diagnostics | 1.5% | 0.1% | 0.07 | 79% | 3.2% |

*Landed* and *rejected* are shares of remarks with a known outcome.

Reading the table:

- What reviewers write most (simplification, reuse of helpers, duplication,
  placement) is not what matters most. Missing cases, loose assertions,
  machine assumptions, tests that do not discriminate and flaky tests carry
  the weight.
- Rejection is rare for every kind of test remark. Authors decline remarks
  about unrealistic setups most (6%), usually because the case cannot occur.

### By language

The commonest problems among substantive test remarks, per language with at
least 150 remarks:

| Language | Remarks | Commonest |
|---|---:|---|
| Go | 2,903 | simplify 14%, missing case 13%, reuse helpers 10%, test logic bug 9% |
| Python | 2,195 | missing case 13%, simplify 12%, reuse helpers 9%, duplication 7%, loose assertion 7% |
| C++ | 1,142 | missing case 22%, simplify 10%, reuse helpers 8%, test logic bug 8% |
| C# | 1,016 | missing case 21%, simplify 10%, loose assertion 9%, reuse helpers 8% |
| Rust | 724 | missing case 16%, needs a test 9%, simplify 8%, environment 6% |
| Java | 424 | simplify 15%, reuse helpers 11%, missing case 9%, test logic bug 9% |
| C | 384 | reuse helpers 14%, simplify 11%, missing case 11%, test logic bug 10% |
| TypeScript | 333 | missing case 17%, loose assertion 8%, reuse helpers 8%, wrong expectation 6% |
| SQL tests | 178 | missing case 41%, loose assertion 10%, wrong expectation 9% |
| Shell | 171 | simplify 16%, test logic bug 12%, environment 9%, cleanup 9% |

### Why authors declined test remarks

| Reason | Remarks |
|---|---:|
| the current behaviour or structure is deliberate | 58 |
| not worth the code or the cost | 54 |
| a matter of taste | 53 |
| the remark misread the code | 34 |
| already handled elsewhere | 16 |
| out of scope | 8 |
| other or unstated | 37 |

### Agent-written changes

See `agents.md` beside this file.

## Limits

- Acceptance is inferred. GitHub's *outdated* flag also fires when nearby code
  changes for other reasons, so shares within the high-value set are more
  reliable than absolute acceptance rates.
- Jev reads text. It does not check whether a reviewer was right.
- The agent comparison rests on 208 agent-written changes with test remarks,
  most of them Copilot changes in .NET projects. Its larger differences hold
  across several projects; small ones should not be read into.
- Lore and Gerrit are under-represented among high-value remarks because
  their outcomes are harder to read.

## Rebuilding

The pipeline is in `pi-improve-skill/mining/` (corpus `code-craft`) in the pi-plugins repository; its
README has the commands. Raw data is cached in `~/.cache/pi-code-craft/` and
reuses the code-review corpus in `~/.cache/pi-code-review/`.
