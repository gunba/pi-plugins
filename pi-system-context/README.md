# pi-system-context

Pi extension that appends a compact local environment summary to the system prompt.

## Context added

```md
### Local env
- time: Fri, 29 May 2026, 10:xx am AWST (Australia/Perth)
- os: Windows_NT 10.0.26100 (win32/x64)
- term: Windows Terminal
- shell: C:/WINDOWS/system32/cmd.exe; bash: ~/Desktop/Programs/PortableGit/bin/bash.exe
- cwd: C:/obsidian
- path tools: python 3.x, node v22.x, git x.x, rg x.x, ps x.x
```

The extension uses short-lived cached PATH probes for common tools so each prompt gets useful environment context without a large prompt block.
