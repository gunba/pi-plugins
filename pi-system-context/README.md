# pi-system-context

Pi extension that appends a compact local environment summary to the system prompt.

## Context added

```md
### Local env
- timezone: Australia/Perth
- os: win32/x64 10.0.26100
- term: Windows Terminal; shell: C:/WINDOWS/system32/cmd.exe; bash: ~/Desktop/Programs/PortableGit/bin/bash.exe
- cwd: C:/obsidian
- path tools: python 3.x, node v22.x, git x.x, rg x.x, ps x.x
```

The extension omits volatile timestamps so Anthropic prompt-cache keys stay stable across turns. PATH probes are short-lived cached so each prompt gets useful environment context without repeatedly shelling out.
