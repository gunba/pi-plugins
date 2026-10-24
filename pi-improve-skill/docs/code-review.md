# The corpus

## Sources

| Source | Projects | Changes | Review units |
|---|---|---:|---:|
| GitHub pull requests | LLVM, Rust, CPython, Kubernetes, OpenJDK, WebKit, systemd, Wasmtime, TypeScript, Node.js, .NET runtime, Tokio, Bitcoin Core, Envoy, Django, NumPy, Swift, PyTorch, OpenSSL, DuckDB, Ruff, etcd | 3,110 | 30,248 |
| kernel.org mailing lists (lore) | linux-mm, netdev, bpf, linux-fsdevel, rust-for-linux, io-uring, linux-block, kvm, git | 934 | 2,200 |
| Go Gerrit | go, tools, crypto, net | 355 | 2,423 |

GitHub changes are a random sample of closed pull requests created between
April 2025 and September 2026 with at least three review threads, at most 40
files and at most 3,000 changed lines. Changes closed without merging are
included, because rejected approaches attract some of the best review. Lore
changes are patches that someone other than the author replied to, spread
evenly over each list's most recent 30,000 messages. Gerrit changes are a
random sample of merged and abandoned changes in the same window with at least
four comments.

A *review unit* is one reviewer comment with its code context and the replies
that followed: a GitHub review thread or a review or conversation comment of
200 characters or more; one inline reply block in a review email (the quoted
patch lines above it are its context); or a Gerrit comment thread.

## Labels

Roles come from metadata where it decides them: the change author's account,
and known bot accounts. Jev, TypeSafe's classifier, answered nine questions
about every unit (`mining/code-review/questions.json`):

- **speaker**: reviewer, author or automation (it caught bots and AI reviewers
  missing from the bot list, and people only typing bot commands);
- **kind**: finding, suggestion, question, nit, ack or process;
- **topic**: one of fourteen aspects of the code;
- **depth** (0 to 3): surface, local, contextual or deep;
- **severity** (0 to 3): cosmetic to crash, data loss or security hole;
- **outcome**: accepted, explained, rejected, deferred or unknown, from the
  replies and the signals (GitHub's *outdated* means the commented code changed
  afterwards; *resolved*; a later version of a kernel patch);
- **concrete**, **proposes_fix**, **beyond_diff**: yes or no.

A second pass assigned a review move (`mining/code-review/moves.json`, 28 choices) to the
18,015 substantive comments of depth 1.5 or more. A third classified the
author's reason in the 658 rejected comments with a reply.

A comment is **high-value** when a human reviewer wrote it, it is a finding,
suggestion or question, depth is at least 2, severity at least 1.5, it is
concrete, and it landed: accepted, likely accepted (outdated and resolved on
GitHub), or, on a mailing list, followed by a new version of the patch with no
rejection.

## Checks on the labels

- A blind hand-labelled sample of 40 reviewer units agreed with Jev on kind for
  about 85% (the disagreements were borderline, such as nit against suggestion,
  plus one junk unit, a bare "[...]", that is now filtered out), and on outcome
  for about 75%. Most outcome disagreements were Jev answering *unknown* where
  GitHub's signals show the code changed; the signal rule above recovers those.
- Depth ranked units in the same order as hand judgement.
- Jev marked the speaker as automation for every AI review bot in a stratified
  sample, including systemd's Claude action, which posts from a generic
  `github-actions` account.

## What the data shows

These figures decided the order and emphasis of the checklist in `SKILL.md`.
All come from the training split.

- Logic accounts for 31% of high-value comments. The largest single move, at
  19%, is a case the code does not handle.
- Concurrency is 3% of substantive comments but 11% of high-value ones. Races,
  work done under a lock, and stale snapshots are 3 to 3.5 times as common
  among high-value comments as among deep comments overall. Lifetime,
  overflow, error-path cleanup and state updated twice or never follow, at
  2 to 2.8 times.
- 99.5% of high-value comments draw on code or knowledge outside the shown
  lines.
- Nits, readability, docs and style make up 40% of what reviewers write about
  code, but 4% of high-value comments.

### Moves

*High-value* is the move's share of the 1,368 high-value comments. *Lift* is
that share divided by the move's share of all 18,015 deep comments.

| Move | High-value | Lift | Human rejection rate |
|---|---:|---:|---:|
| missed_case | 18.9% | 2.0 | 3.2% |
| simpler_design | 8.1% | 0.6 | 7.4% |
| wrong_condition_or_value | 5.8% | 1.5 | 2.4% |
| hot_path_cost | 5.3% | 1.4 | 3.7% |
| race_condition | 5.3% | 3.5 | 2.4% |
| explain_document | 5.3% | 0.4 | 2.6% |
| reuse_existing | 4.8% | 0.4 | 4.2% |
| lifetime_ownership | 4.2% | 2.5 | 3.3% |
| api_misuse | 4.0% | 1.5 | 2.0% |
| missing_test | 3.7% | 0.7 | 2.7% |
| not_behaviour_preserving | 3.5% | 1.8 | 3.3% |
| state_update_error | 3.1% | 2.2 | 2.7% |
| wrong_place | 3.1% | 0.8 | 4.1% |
| spec_contract_mismatch | 2.9% | 1.8 | 3.6% |
| arithmetic_bounds | 2.9% | 2.4 | 4.5% |
| rollout_gating | 2.8% | 1.3 | 2.9% |
| platform_assumption | 2.6% | 1.5 | 4.9% |
| ordering_staleness | 2.2% | 3.1 | 6.5% |
| error_path_cleanup | 2.2% | 2.8 | 1.1% |
| error_lost_or_unchecked | 2.1% | 1.4 | 3.6% |
| compat_break | 2.0% | 1.5 | 4.2% |
| test_quality | 1.3% | 0.3 | 5.2% |
| security_boundary | 1.2% | 2.0 | 5.8% |
| hidden_control_flow | 0.8% | 1.6 | 4.0% |
| blocking_under_lock | 0.7% | 3.5 | 0.0% |
| partial_failure_consistency | 0.4% | 2.0 | 0.0% |
| naming_readability | 0.4% | 0.1 | 7.5% |

### Languages

Each cell gives a topic's share of the language's high-value comments, with
its share of all substantive comments in brackets. JavaScript, TypeScript and
Swift have too few high-value comments for a profile.

| Language | Substantive | High-value | Top topics among high-value (share of all) |
|---|---:|---:|---|
| C++ | 3,506 | 293 | logic 37% (18%), design 12% (19%), concurrency 10% (2%), error handling 10% (8%), memory 10% (3%) |
| C | 1,401 | 124 | logic 26% (17%), memory 20% (9%), concurrency 10% (3%), build/platform 9% (3%), design 9% (13%) |
| C, kernel lists | 904 | 78 | logic 29% (14%), concurrency 18% (9%), memory 14% (6%), design 13% (21%), error handling 9% (6%) |
| Rust | 2,334 | 185 | logic 30% (14%), concurrency 16% (3%), design 15% (19%), error handling 9% (4%), memory 9% (4%) |
| Go | 2,684 | 196 | logic 35% (17%), design 14% (17%), concurrency 13% (4%), performance 8% (5%), error handling 7% (7%) |
| Python | 1,688 | 56 | logic 29% (12%), tests 12% (30%), API/compat 12% (5%), design 11% (11%), performance 7% (3%) |
| Java | 409 | 18 | error handling 28% (6%), concurrency 17% (5%), tests 17% (18%), logic 17% (13%) |
| C# | 292 | 23 | logic 35% (13%), concurrency 13% (3%), build/platform 13% (5%), design 13% (17%) |
| Whole-change comments | 3,451 | 292 | logic 27% (10%), design 14% (19%), performance 11% (6%), build/platform 11% (11%), API/compat 10% (9%) |

### Outcomes by kind of comment (human reviewers)

| Kind | Share | Accepted | Explained | Rejected |
|---|---:|---:|---:|---:|
| finding | 22% | 69% | 15% | 2.2% |
| suggestion | 42% | 71% | 12% | 4.9% |
| question | 13% | 34% | 54% | 1.5% |
| nit | 15% | 88% | 6% | 1.9% |

### AI reviewers against people in the same projects

| Reviewer | Comments | Rejected | People, same projects | AI questions | People's questions | AI design | People's design |
|---|---:|---:|---:|---:|---:|---:|---:|
| Claude (systemd's review action) | 726 | 11.5% | 2.2% | 0% | 7.3% | 3.2% | 12.3% |
| Gemini Code Assist (Envoy) | 104 | 13.3% | 2.8% | 0% | 15.8% | 1.0% | 14.6% |
| BPF CI AI review (bpf list) | 119 | 15.4% | 2.6% | 5.9% | 16.1% | 4.2% | 16.1% |
| Copilot (.NET, TypeScript, Node.js, Envoy and others) | 1,231 | 4.0% | 2.6% | 0% | 13.6% | 3.3% | 12.2% |
| Codex (Ruff, PyTorch) | 79 | 2.4% | 2.3% | 0% | 13.7% | 0% | 11.0% |

### Why authors rejected comments

Jev's reading of the author's reply, for the 658 rejected comments that had
one.

| Reason | AI (75) | People (583) |
|---|---:|---:|
| behaviour is deliberate | 20% | 28% |
| not worth the code or cost | 19% | 17% |
| misreads the code, an API or a spec | 17% | 10% |
| out of scope or pre-existing | 12% | 4% |
| already handled elsewhere | 9% | 5% |
| matter of taste | 5% | 20% |
| other or unstated | 17% | 15% |

## Splits

Changes are split by a hash of their identity: 85% train, 15% holdout. Every
number and example in this skill comes from the training split. The holdout
changes are the benchmark.

## Limits

- Acceptance is inferred, and GitHub's *outdated* flag also fires when nearby
  code changes for other reasons. Shares within the high-value set are more
  reliable than absolute acceptance rates.
- Mailing-list outcomes are often unknown, because kernel authors answer review
  with a new version rather than a reply. Lore units are under-represented in
  the high-value set.
- JavaScript, TypeScript, Swift, Java and C# have few high-value comments, so
  their profiles in `languages.md` are thin.
- Jev reads text; it does not check whether a reviewer was right. A comment the
  author accepted can still have been wrong.

## Rebuilding

The pipeline lives in `pi-improve-skill/mining/` (corpus `code-review`) in the pi-plugins repository
(`README.md` there has the commands). Raw data is cached in
`~/.cache/pi-code-review/`.
