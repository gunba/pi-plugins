# pi-codex-compat

Codex-shaped `apply_patch`, `shell_command`, `write_stdin`, and `view_image`
tools for Pi. The overlay activates for Codex-like models while preserving the
rest of the active tool set.

## Design provenance

The tool-surface design is informed by the MIT-licensed
[`pi-codex-conversion`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion)
package. This implementation keeps the compatibility layer integrated with the
local `pi-plugins` package and its context-mode guardrails, atomic patching,
session-image repair, and regression suite.
