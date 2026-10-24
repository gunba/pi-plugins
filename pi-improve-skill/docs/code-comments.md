# The corpus

The review data is shared with the `test-writing` skill: 14,522 reviewed
changes from 64 projects on GitHub, kernel.org mailing lists, and Go's and
Chromium's Gerrit, collected April 2025 to September 2026, including 1,986
changes written by coding agents. See `tests.md` for
the sources and sampling.

## Labels

Jev, TypeSafe's classifier, read 46,005 review units on test files or that
mention tests or comments, and marked 8,624 written by people as being about
comments or doc comments in code. Those it then labelled with one of 16
problems (`mining/code-craft/comment-moves.json`), along with kind, depth, severity,
concreteness and outcome.

A remark is **high-value** when a person wrote it, it is a finding,
suggestion or question, depth is at least 1.5, severity at least 1.2 (above
"harder to maintain", towards "misleads the reader"), it is concrete, and it
landed. Comment problems rarely break anything, so the bar is lower than for
tests.

## What the data shows

From the training split (85% of changes). *Share* is the problem's share of
the 7,217 remarks about comments (findings, suggestions, questions and nits);
*high-value* is its share of the 373 high-value remarks; *lift* is the ratio.

| Problem | Share | High-value | Lift | Landed | Rejected |
|---|---:|---:|---:|---:|---:|
| wrong_or_stale | 13.2% | 35.1% | 2.66 | 84% | 1.1% |
| document_contract | 4.5% | 16.1% | 3.58 | 84% | 2.2% |
| api_docs | 12.4% | 15.8% | 1.27 | 83% | 2.6% |
| unclear | 16.7% | 14.5% | 0.87 | 82% | 1.7% |
| explain_why | 13.1% | 13.4% | 1.02 | 79% | 2.1% |
| placement | 2.4% | 1.9% | 0.79 | 88% | 0.7% |
| reference | 2.6% | 1.3% | 0.50 | 84% | 2.6% |
| format_convention | 9.5% | 0.8% | 0.08 | 92% | 0.8% |
| redundant | 8.5% | 0.5% | 0.06 | 90% | 2.5% |
| todo | 2.4% | 0.3% | 0.13 | 63% | 2.0% |
| commented_out_code | 0.9% | 0.3% | 0.33 | 89% | 0% |
| typo_grammar | 9.1% | 0% | 0 | 91% | 0.3% |
| too_long | 2.0% | 0% | 0 | 86% | 0% |
| change_narrative | 1.0% | 0% | 0 | 85% | 3.4% |
| code_instead | 0.7% | 0% | 0 | 74% | 6.5% |

Remarks about comments are among the most accepted of all review remarks:
82 to 92% land. Authors decline them mostly as a matter of taste (37 of 96
declines with a reply), so the project's own conventions settle most
disputes.

## Agent-written changes

The 14 projects that have both agent-written and person-written changes with
comment remarks, counting changes rather than remarks. Each figure is the
share of changes with comment remarks that drew at least one remark of that
kind: 123 agent changes, 756 people's changes.

| Remark | Agent changes | People's changes | Ratio |
|---|---:|---:|---:|
| narrates the change | 7.3% | 1.3% | 5.5 |
| should be code instead | 3.3% | 0.8% | 4.1 |
| cites a source | 8.9% | 4.4% | 2.0 |
| repeats the code | 17.9% | 9.8% | 1.8 |
| too long | 8.1% | 4.5% | 1.8 |
| wrong or stale | 28.5% | 20.4% | 1.4 |
| unclear | 18.7% | 20.0% | 0.9 |
| needs a reason | 13.0% | 26.2% | 0.5 |
| typo or grammar | 2.4% | 12.4% | 0.2 |

The small rows rest on few changes (narration: 9 changes in 4 projects; code
instead: 4 changes), but they agree with the larger ones. Agents write too
much and describe their own work. People write too little and leave typos.
The "cites a source" row is mostly reviewers asking for a precise source:
a permalink instead of a path that will change, the documentation page instead
of the source code, a cross-reference to the API instead of a native function
name. Twice it was the opposite: an issue link that stood in for an
explanation ("Code should be ideally commented enough to not need 'external'
issue links").

Agent changes drew fewer comment remarks per change than people's (0.23
against 0.44), partly because maintainers close weak agent changes rather
than review them line by line.

## The projects' own commenting guides

| Guide | What it adds |
|---|---|
| [Linux kernel coding style, ch. 8](https://www.kernel.org/doc/html/latest/process/coding-style.html#commenting) | Tell what the code does, not how; put comments at the head of the function, not scattered through the body; kernel-doc for APIs, without boilerplate that repeats the signature. |
| [LLVM Coding Standards: commenting](https://llvm.org/docs/CodingStandards.html#commenting) | File, class and function comments; Doxygen use; describe what and why. |
| [Go Doc Comments](https://go.dev/doc/comment) | Doc comments are full sentences that start with the name they document; what the package, function or type does and what callers must know. |
| [Google C++ style: comments](https://google.github.io/styleguide/cppguide.html#Comments) | Function comments describe use; implementation comments explain tricky or non-obvious parts; do not state the obvious. |
| [Rust API Guidelines: documentation](https://rust-lang.github.io/api-guidelines/documentation.html) | Examples; `# Errors`, `# Panics` and `# Safety` sections; links to related items. |
| [PEP 8: comments](https://peps.python.org/pep-0008/#comments) | "Comments that contradict the code are worse than no comments"; keep them up to date when the code changes. |

## Limits

- Acceptance is inferred from replies and signals; Jev reads text and does
  not check whether a reviewer was right.
- 373 high-value remarks is a small set; the shares within it move by a few
  points with the threshold.
- The agent comparison rests on 123 agent-written changes, mostly Copilot
  changes in .NET projects.

## Rebuilding

See `pi-improve-skill/mining/README.md` in the pi-plugins repository (corpus `code-craft`).
