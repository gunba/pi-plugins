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

# Releasing and deploying

A release takes about 20 minutes. If it is taking much longer, something is
broken: stop and tell Jordan what failed in one plain sentence.

1. Bump `version` in `pi-desk/package.json` (and the root `package.json` when
   plugins changed). Commit, push `main`, `gh run watch` the CI run.
   If a test flakes, fix every test with that pattern in one pass.
2. `git tag pi-desk-v<version> && git push origin pi-desk-v<version>`, then
   `gh run watch` the `Desk release` run.
3. On each computer, `pi update --extension git:github.com/gunba/pi-plugins`
   so terminal Pi matches. Running conversations are not affected.
4. Update each computer's host: **Settings & tools → Computers → Update now**,
   or on that computer, from `~/.pi/agent/git/github.com/gunba/pi-plugins`,
   run `node pi-desk/manage/deploy.ts host <version>`. Host updates do not
   interrupt running conversations; do not wait for them to go idle.
5. If `pi-desk/src/client`, `src/shared` or `public` changed, run
   `node pi-desk/manage/deploy.ts website` on Fedora after its host update.
6. Tell Jordan the version, which computers run it, and which open
   conversations still need a restart to pick up plugin changes. Done.

Running conversations keep the code they started with. Plugin fixes (command
guard, tools, providers) reach a conversation only after it restarts: idle ones
have **Settings & tools → Conversation → Restart on Desk <version>** (or
`POST /api/sessions/<key>/restart {"replace":true}`). Do not script it further;
name busy conversations and let Jordan restart them.

Do not:

- write per-release scripts, receipts, before/after captures or hash checks;
  CI and the updater already verify releases;
- run isolated loader/inspector checks or the full suite on the hosts;
- add your own timeouts to staging or updates; Windows unpacking is slow;
- coordinate another computer's agent with GO/NO-GO messages, or hold an
  update because some conversation is busy;
- report progress in abbreviations, hashes or PIDs. Use plain sentences.

Desk deletes runtime versions nothing uses before preparing another. A process
that runs a version from outside Desk must be listed first:
`node pi-desk/manage/deploy.ts prune --keep <runtime id prefix>`.

When a fix is meant to change behaviour Jordan sees (a prompt, a block, a
layout), confirm that behaviour is gone in a new conversation before
reporting it fixed. Check for older copies of the same feature still loaded,
such as `~/.pi/agent/extensions/*`.
