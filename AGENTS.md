# Development

Use Node 22.19+ and the pinned dependencies. Run commands from the repository
root unless using `npm --prefix pi-desk`.

Choose checks for the changed code:

- Extensions: `npm run typecheck` and the relevant existing test file, for example
  `node --test pi-codex-compat/tests/tool-arguments.test.mjs`.
- Narrow a regression run with
  `node --test --test-name-pattern="pattern" path/to/file.test.mjs`.
- Desk: `npm --prefix pi-desk run typecheck` and the relevant
  `node --test pi-desk/tests/<name>.test.mjs`.
- Desk client or packaging changes: `npm --prefix pi-desk run build`.

Do not run the full suite by default. Reserve `npm run check`, plus Desk's
typecheck/build, for integration or release validation.

Main pushes run Linux/Node 22 and Windows/Node 24 CI. `workflow_dispatch` runs
all four OS/Node combinations. Feature pushes and pull requests do not run CI.
The four-way native runtime build runs only for `pi-desk-v*` release tags.
