# Process and image tools

This extension adds managed process execution and image tools to Pi. File changes
use native `edit` and `write`; native `bash` remains available. Tools work directly
or through Pi's native codemode.

## Managed processes

`exec_command` runs a shell command with piped output. It returns completed output
or a session ID for background work. Processes are owned by the native Pi session,
so different sessions do not share process IDs or output cursors.

- Omit `yield_time_ms` for ordinary commands.
- Short waits are useful for persistent services or independent concurrent work.
- Completion notifications announce finished background commands.
- `write_stdin` collects the result once, or accepts exact Ctrl+C to interrupt the
  process tree. Other input is unavailable because this runner uses plain pipes.
- Full output is saved outside the project when the display budget is exceeded.
- Launches can run concurrently; polls on one process serialize their output cursor.

The runner does not allocate PTYs or ConPTY. `tty: true` is rejected. Defaults and
metadata follow the Unified Exec contract; process control is not model-specific.

## Images

`view_image` validates local image data and returns native Pi image blocks for
image-capable models. Text-only models can use an authenticated image-capable
model for a concise description instead.

`image_gen` generates or edits images with GPT Image 2.5 Sunburst or Flare.
Generation needs `prompt` and `model`. Edits also take one reference mode:
`referenced_image_paths` for local files, or `num_last_images_to_include` for recent
conversation images. Each supports up to five references.

Outputs are saved under `$CODEX_HOME/generated_images` (default `~/.codex/generated_images`).
Image generation requires an eligible OpenAI/ChatGPT model and configured
authentication. Available image tools change with model capabilities and
authentication, while explicit tool selections are preserved.

## Attribution

The process contract and standalone image protocol derive from
[OpenAI Codex](https://github.com/openai/codex), under Apache-2.0. See
[`NOTICE`](NOTICE) and [`LICENSE-APACHE-2.0`](LICENSE-APACHE-2.0).
