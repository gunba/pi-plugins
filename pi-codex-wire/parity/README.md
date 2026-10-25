# Keeping Codex Wire in step with Codex

Codex Wire sends Pi's requests the way the latest stable Codex (Desktop and CLI) sends its own. When Codex changes
what it sends, Wire follows. This folder holds what the parity agent, a sleeping Desk conversation on the Perth server,
uses to notice a release that matters and to work out what Wire needs.

## Rules

- **Match native wherever it is free.** Field order, IDs, metadata, headers, transport behaviour and request shapes
  follow the official binary.
- **Never inject Codex's harness messages.** These are skills, permissions, environment, collaboration mode and
  multi-agent instructions. The model reads them, so they are not free. Pi keeps its own prompt.
- **One tool set for every model.** Wire adds no Codex-specific tool names.
- **Don't break prompt caching without need.** IDs and times are derived from Pi's messages, so every request describes
  history the same way. A change that alters what earlier items look like costs each conversation one uncached request.
  Say so in the report.
- **No upstreaming to Pi.** Changes live in `pi-codex-wire`.
- **Tests only for ported behaviour or observed regressions.** Check against captures from the official binary rather
  than writing tests for guesses.
- **Leave the identity version alone.** `version.ts` follows the latest stable release by itself.

## The watch

```js
watch({
  command: "python3 ~/codex-parity/pi-plugins/pi-codex-wire/parity/check.py",
  every: 21600,
  wake_when: "a new Codex release changes what Codex sends to or reads from the Responses API: request or tool fields, input item shapes or metadata, headers, client or turn metadata, the websocket transport, compaction or authentication",
  close: true,
})
```

`check.py` prints the latest stable release and the changes to the files that build model requests since
`~/codex-parity/baseline`. Its output changes only with a release, and the classifier wakes the agent only for releases
that touch requests. The conversation sleeps in between: no process runs, and the watch's runner re-runs the check.

## On Perth

| Path | What |
|---|---|
| `~/codex-parity/pi-plugins` | A clone of this repository for preparing changes. It is not the installed copy. |
| `~/codex-parity/codex` | A partial clone of `openai/codex` that `check.py` maintains: history and tags, with file contents fetched as read. |
| `~/codex-parity/baseline` | The Codex tag Wire last matched, such as `rust-v0.164.0`. |
| `~/codex-parity/reports/<tag>/` | One folder per release: `report.md` and the patches. |

Perth cannot push to GitHub, so changes reach Jordan as patches.

## When a release wakes you

1. **Start from a fresh `main`.** Run `git -C ~/codex-parity/pi-plugins pull --ff-only`, then create the branch
   `parity/<tag>`.
2. **Read what changed.** Run `git -C ~/codex-parity/codex diff <baseline> <tag> -- <the PATHS in check.py>`. Then read
   the new versions of the changed files whole (`git -C ~/codex-parity/codex show <tag>:<path>`). Look for files that
   moved, and update `PATHS` if requests are now built elsewhere.
3. **List each change to requests.** For each one, record:
   - what it is and where Codex makes it;
   - whether it is free (no model-visible text);
   - what Wire does today.

   Where Wire handles each area:

   | Wire file | Handles |
   |---|---|
   | `identity.ts` | originator and user agent |
   | `protocol.ts` | headers, client and turn metadata, window and turn IDs |
   | `request-order.ts` | field orders |
   | `history.ts` | item IDs and passthrough metadata |
   | `model-shape.ts` | Lite shaping, tools, instructions |
   | `transport.ts` | WebSocket and HTTPS, prewarm, continuation |
   | `compact.ts`, `native-compaction.ts`, `compact-input.ts` | remote compaction |
   | `workspace.ts` | git workspaces |
   | `prompt.ts` | the native intro |
   | `catalog.ts` | the model catalog |
4. **Check against the official binary** when request shapes change. See "Captures" below.
5. **Implement the free changes** on the branch.
   - Update the version and commit references in `pi-codex-wire/README.md` ("Request bodies follow Codex CLI …").
   - Run `node --test pi-codex-wire/tests/*.test.mjs`.
   - Run the whole suite from the repository root: `npm ci` once, then
     `env -u PI_DESK_RUNTIME npm test -- --test-concurrency=2`.
6. **Deliver.**
   - Write `~/codex-parity/reports/<tag>/report.md`:
     - what changed in Codex;
     - what Wire changes;
     - what is left out and why;
     - the prompt-cache impact;
     - the test and capture results.
   - Write the patches beside it: `git format-patch origin/main -o ~/codex-parity/reports/<tag>/`.
   - Add a quest for Jordan: "Review the Codex Wire parity patch for <tag>". Name the computer (pi-desk-perth) and the
     folder. Any Desk agent can fetch the files from there with `agent_send`.
   - If nothing needs to change, the report says so and no quest is added.
7. **Move on.** Write the new tag to `~/codex-parity/baseline`, set the same watch again, and end your turn.

## Captures

This is how Codex 0.164.0 parity was checked. Keep any tooling you build in this folder, so the next release reuses it.

1. **Run a local capture server.** It records every request (headers and body, and each WebSocket frame) as JSON lines,
   and answers them as the Responses API does:
   - a model catalog;
   - `POST …/responses` with server-sent events;
   - a WebSocket upgrade on the same path, which streams `response.created`, output items and `response.completed`
     for each `response.create`.

   It can answer a turn with a tool call, then with text, so a turn's continuation is captured too.
2. **Native.** Download the release's `codex-x86_64-unknown-linux-musl.tar.gz`. Give it a `CODEX_HOME` whose
   `config.toml` sets `openai_base_url` to the capture server, and set `CODEX_API_KEY=dummy-key`. Then run
   `codex exec` with a short prompt.
3. **Wire.** Run `pi -p --no-session` with `PI_CODING_AGENT_DIR` set to a scratch agent folder. Its `auth.json` holds
   an `openai-codex` login with a fake ChatGPT JWT. Set `HTTPS_PROXY` to the capture server in proxy mode, which
   terminates TLS for `chatgpt.com` with a throwaway certificate, and set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
4. **Run the same scenarios on both:**
   - a first turn;
   - a turn with a tool call and its continuation;
   - a resumed conversation (`cold_resume`);
   - a prewarm, with Wire's prewarm on;
   - compaction, when it changed.
5. **Compare:**
   - the order of top-level fields;
   - `client_metadata` keys;
   - `x-codex-turn-metadata` keys, order and values;
   - headers;
   - each input item's type, role, keys, passthrough keys and content kinds.

   Leave out the following:
   - Codex's harness messages: content kinds starting `host_skills`, `permissions`, `collaboration_mode`,
     `multi_agent` or `environments`.
   - `turn_trigger`, which only `codex exec` sends.

Delete the scratch folders and the downloaded binary when done.
