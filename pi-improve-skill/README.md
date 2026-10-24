# Improve skill

Builds and improves skills from evidence.

- [`skills/improve-skill`](skills/improve-skill/SKILL.md): the procedure an agent follows. It mines real examples of
  experts' work to learn what matters, writes the skill as instructions, then improves it in rounds on benchmark
  cases, with held-out cases confirming each gain.
- [`mining`](mining/README.md): collects maintainers' review from GitHub, Gerrit and kernel.org mailing lists and
  labels it with TypeSafe's Jev classifier. One set of miners and one labelling script serve every corpus; each
  corpus folder (`code-review`, `code-craft`) holds its sources, Jev questions and build step.
- `bench`: benchmarks for the skills in [`pi-code-skills`](../pi-code-skills/README.md): `code-review` and
  `code-craft` (test writing and code comments).
- [`docs`](docs/README.md): what each corpus contains and how the skills score.
