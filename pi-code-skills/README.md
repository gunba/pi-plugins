# Code skills

Three skills for coding agents:

- [`code-review`](skills/code-review/SKILL.md): review a change the way maintainers of top projects do: work out what
  it must do, read past the diff, verify each point against the code, and write comments the author will act on.
- [`test-writing`](skills/test-writing/SKILL.md): write tests that fail without the change, cover the cases that
  matter, assert exact results and pass on every machine; never weaken a test to get a green run.
- [`code-comments`](skills/code-comments/SKILL.md): keep comments true after a change, write down contracts and reasons
  the code cannot show, and leave out narration of the change and comments that repeat the code.

Each skill is instructions, plus real review remarks from maintainers as examples (`references/`) and a script that
searches them. They were built and benchmarked with [`pi-improve-skill`](../pi-improve-skill/README.md), whose
`docs/` has the corpora and results.
