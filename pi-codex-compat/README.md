# pi-codex-compat

Codex-shaped `apply_patch`, `shell_command`, `write_stdin`, `view_image`, and
`image_gen` tools for Pi. The overlay activates for compatible Codex/OpenAI
models while preserving the rest of the active tool set. Generated images are
published under `CODEX_HOME/generated_images` (default `~/.codex/generated_images`).
Text-only Codex models use an authenticated image-capable model for concise
`view_image` descriptions and receive saved paths from `image_gen`.

## Design provenance

The general tool-surface design is informed by the MIT-licensed
[`pi-codex-conversion`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/2483569cf389a7d199c74a89087a0257b23bed0e/packages/pi-codex-conversion)
package. The image-generation request contract, edit-reference behavior, and
fixed defaults follow the Apache-2.0 licensed
[`openai/codex` image-generation extension](https://github.com/openai/codex/tree/54c44b9ed4c7d6d1ec9bf7897bb76f6411d8e033/codex-rs/ext/image-generation) and
[`ImagesClient`](https://github.com/openai/codex/blob/54c44b9ed4c7d6d1ec9bf7897bb76f6411d8e033/codex-rs/codex-api/src/endpoint/images.rs).
This implementation keeps the compatibility layer integrated with the local
`pi-plugins` package and its context-mode guardrails, atomic file publication,
session-image repair, and regression suite.
