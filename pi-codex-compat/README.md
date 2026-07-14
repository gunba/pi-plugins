# pi-codex-compat

Codex-shaped `apply_patch`, `exec_command`, `write_stdin`, `view_image`, and
`image_gen` tools for Pi. The overlay activates for compatible Codex/OpenAI
models with exact provider/API checks and preserves the rest of the active tool
set without resurrecting tools removed while the overlay is active. Pi's
built-in `bash` deliberately remains visible beside `exec_command`: suppressing
it would lose host-owned behavior, and Pi does not expose enough state to later
distinguish extension suppression from a manual disable. Generated images are
published under `CODEX_HOME/generated_images` (default `~/.codex/generated_images`).
Text-only Codex models use an authenticated image-capable model for concise
`view_image` descriptions and receive saved paths from `image_gen`.

## Apply patch

`apply_patch` accepts the Codex Begin/End Patch envelope through Pi's JSON
function fallback. Add, delete, update, move, CRLF, EOF markers, blank context,
and the four Codex context-matching tiers are supported. Repeated pure additions
at the same location retain patch order. Shell interception uses a structural
recognizer for the complete `apply_patch <<DELIMITER` and
`cd <one argument> && apply_patch <<DELIMITER` forms; extra commands, arguments,
connectors, redirects, or expansions are left to the normal shell.

`*** Environment ID:` is rejected because extensions cannot route filesystem
operations to attached environments. File mutations remain staged with
best-effort rollback, same-path moves remain safe, sequential sections can use
earlier staged changes, and rendering reports effective original-to-final
changes. Rollback attempts every file, removes directories created by the
failed application, verifies residual state, and reports any rollback errors.
Existing CRLF files retain their line-ending style. These are intentional
safety improvements over partial mutation.

Successful and failed model output uses Codex's exit-code, wall-time, and
`Output:` framing. Pi's `tool_result` lifecycle marks verification/application
failures as real tool errors while retaining structured change/error details.

## Unified Exec sessions

The provider-visible surface is the Unified Exec `exec_command` contract:
`cmd` is required; `workdir`, `tty`, `yield_time_ms`, `max_output_tokens`,
`shell`, and `login` are optional; unknown properties are rejected. There is no
provider hard-timeout field. Wrong-type and fractional integer values are
rejected before Pi's schema coercion. Login-shell behavior defaults to true. The initial
output wait defaults to 10,000ms and is clamped to 250–30,000ms
(2,000–30,000ms on Windows); a command that outlives it returns an owner-scoped
random `session_id` in Codex's reserved 1000–99999 range. Sessions are owned by
the Pi extension/session instance that created them; another session cannot poll
or shut them down. An omitted `shell` uses the user's `SHELL`/`ComSpec` when
available and falls back to Pi's shell resolver.

For `write_stdin`, non-empty writes default to 250ms and clamp to
250–30,000ms. Omitted or empty `chars` perform a poll whose default and minimum
are 5,000ms. Empty polls are capped by
`PI_CODEX_BACKGROUND_TERMINAL_MAX_TIMEOUT_MS`, which defaults to 300,000ms and
is normalized to at least 5,000ms. Each call returns only newly available
output while Pi receives throttled incremental updates during the call.

Each result follows Codex's model-facing shape: a six-hex-digit chunk ID, wall
time, exit or session status, approximate original token count, and `Output:`
body. Output is collected as bytes in a UTF-8-safe 1MiB symmetric head/tail
buffer. The model-facing budget defaults to 10,000 approximate tokens and also
preserves the head and tail. When either limit truncates output, the complete
combined stdout/stderr stream remains available at the returned Pi temp-log
path. Raw log writes apply stream backpressure. A complete log is capped at
64 MiB; retained logs are session-scoped and bounded to eight files/64 MiB by
LRU, then removed at extension shutdown. Non-truncated logs are removed as soon
as their process is released. Model-facing output strips terminal escape,
control, surrogate, and unsafe Unicode format characters while retained logs
keep the original bytes.

Each session store is capped at 64 processes. Pruning protects the eight most
recently used sessions, then prefers the oldest exited session before the oldest
remaining live session. Spawned commands receive Codex's noninteractive
defaults (`NO_COLOR=1`, `TERM=dumb`, UTF-8 locale variables, disabled colour,
`cat` pagers, and `CODEX_CI=1`).

### Deliberate host-level differences

Codex core owns its PTY/ConPTY, sandbox, approval, remote-exec, and turn lifecycle.
Those facilities are not exposed to an extension, and adding a native PTY shim
here would not reproduce their ownership or cancellation semantics reliably
across platforms. This runtime therefore uses ordinary pipes and rejects
`tty:true` before spawning rather than claiming to provide a PTY. For the
default `tty:false`, child stdin is closed: `write_stdin` accepts polling and an
exact U+0003 Ctrl-C interrupt only, rejecting all other non-empty input. Unix
interrupts target the process group; Windows uses `taskkill /T`, whose signal
semantics necessarily differ. The `taskkill` result is observed and bounded;
failure is surfaced instead of falling back to a potentially reused PID or
claiming successful tree shutdown. Signal exits remain distinct from numeric
exit codes.

Pi cancellation during an active tool call terminates that process. Session IDs
exist only in the owning Pi session and are released after completion, LRU
pruning, or session shutdown. `apply_patch` heredoc interception and
Pi/context-mode HTTP and large-output guardrails remain in front of execution.
HTTP guard blocks, unknown sessions, launch/transport failures, and aborted
calls are real Pi tool errors. Ordinary nonzero process exits remain successful
Unified Exec results, matching Codex protocol semantics.

## Images

`view_image` and local `image_gen` references are limited to 20 MiB per file.
Image-generation HTTP response bodies are read through a 32 MiB bounded stream,
and decoded generated images are limited to 20 MiB. Live and resumed image
blocks are byte-sniffed against their declared MIME type; BMP is converted to a
provider-supported format and invalid historical blocks are replaced with a
textual omission marker before provider serialization. Historical conversions
run with bounded concurrency.

Recent-image editing uses Pi's compaction-aware context entries, excludes orphan
tool outputs, retains chronological order, and falls back to the saved path in
text-only `image_gen` result details. Generated results retain call ID, saved
path, byte count, operation, and any API-provided revised prompt. Saving remains
atomic and mandatory. The image tool metadata directs immediate generation
without redundant reconfirmation and prefers `image_gen` over Python editing
unless the user explicitly asks otherwise.

Image generation is advertised only for supported OpenAI/Codex model metadata
when Pi reports configured authentication. Text-only activation remains an
intentional Pi adaptation so generated files and delegated visual descriptions
remain usable.

## Host boundaries

Pi extensions expose flat JSON function tools only. Freeform custom
`apply_patch` grammar calls, custom-tool result wire types, namespaced
`image_gen.imagegen`, provider output schemas, per-image detail metadata,
provider capability flags, attached-environment routing, native PTY/ConPTY,
Windows Job Object ownership, sandbox/approval ownership, and remote execution
require Pi core support and are not emulated here.

## Design provenance

The general tool-surface design is informed by the MIT-licensed
[`pi-codex-conversion`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/2483569cf389a7d199c74a89087a0257b23bed0e/packages/pi-codex-conversion)
package. The image-generation request contract, edit-reference behavior, and
fixed defaults follow the Apache-2.0 licensed
[`openai/codex` image-generation extension](https://github.com/openai/codex/tree/54c44b9ed4c7d6d1ec9bf7897bb76f6411d8e033/codex-rs/ext/image-generation) and
[`ImagesClient`](https://github.com/openai/codex/blob/54c44b9ed4c7d6d1ec9bf7897bb76f6411d8e033/codex-rs/codex-api/src/endpoint/images.rs).
The Unified Exec schema, result shape, buffering, environment, process-store,
timing, and polling policy follow Apache-2.0 licensed
[`openai/codex` Unified Exec at `d7ba5ff9553a6aa0898a8e3bd5cb3bc00d0c9ddf`](https://github.com/openai/codex/tree/d7ba5ff9553a6aa0898a8e3bd5cb3bc00d0c9ddf).
This implementation keeps the compatibility layer integrated with the local
`pi-plugins` package and its context-mode guardrails, atomic file publication,
session-image repair, and regression suite.
