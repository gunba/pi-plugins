# Improve skill

Tooling for building and iterating on skills, kept in one place.

- [`skills/improve-skill`](skills/improve-skill/SKILL.md): improves a skill in rounds on benchmark cases, with
  held-out cases confirming each gain. Suits skills judged on their output, such as consulting deliverables.
- [`mining`](mining/README.md): collects maintainers' review from GitHub, Gerrit and kernel.org mailing lists and
  labels it with TypeSafe's Jev classifier. It built the code skills in
  [`pi-code-skills`](../pi-code-skills/README.md), where experts' judgement is public; each corpus has its own folder.
- `bench`: the benchmarks for those code skills.
- [`docs`](docs/README.md): what the corpora contain and how the code skills score.
