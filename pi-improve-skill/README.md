# Improve skill

Tooling for building and iterating on skills, kept in one place. The skills themselves live in Pi's skills folder
(`~/.pi/agent/skills`), which Desk mirrors to the user's other computers.

- The `improve-skill` skill improves a skill in rounds on benchmark cases, with held-out cases confirming each gain.
  It suits skills judged on their output, such as consulting deliverables; each run's driver lives with its cases.
- [`mining`](mining/README.md): collects maintainers' review from GitHub, Gerrit and kernel.org mailing lists and
  labels it with TypeSafe's Jev classifier. It built the `code-review`, `test-writing` and `code-comments` skills,
  whose experts' judgement is public; each corpus has its own folder.
- `bench`: the benchmarks for those code skills.
- [`docs`](docs/README.md): what the corpora contain and how the code skills score.
