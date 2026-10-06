# DeepSeek Harness design attribution

This package's original subagent design was adapted from the DeepSeek Harness
subagent packages, including fresh/fork contexts, continuable background work,
FIFO later-turn messaging, current-turn interruption, direct-parent reporting,
durable descriptors, cold resumption, bounded depth and settlement notices.
The current [tool contract](README.md) follows Codex V2; this attribution records
the earlier design's contribution.

Source reviewed:

- DeepSeek Harness repository at commit
  `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, `packages/subagent/**`
- Copyright (c) 2026 DeepSeek
- License: MIT

No DeepSeek Harness runtime code is included. The original implementation mapped
the design to Pi 0.84.3's `AgentSession`, `SessionManager`, extension and TUI APIs;
the current implementation uses Pi 1.0.

## MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
