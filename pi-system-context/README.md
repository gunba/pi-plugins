# pi-system-context

Pi extension that adds a compact local environment summary through Pi's native
structured prompt options. Pi records it with the other prompt sections; it does
not replace the complete system prompt or inject reminder messages.

## Context added

```md
### Local env
- timezone: Australia/Perth
- os: win32/x64 10.0.26100
- shell: C:/WINDOWS/system32/cmd.exe; bash: ~/Desktop/Programs/PortableGit/bin/bash.exe
- path tools: python 3.x, node v22.x, git x.x, rg x.x, ps x.x

### Tools to load
Load these with tool_search when needed: agents (agent_create, …); quests (…).
```

Pi's own `<cwd>` section carries the folder. The tool versions are probed once per
process, so the section only changes when the computer or the registered tools do,
which keeps the prompt cache.

The extension also replaces Pi's documentation section with a one-line pointer,
drops rules that repeat tool descriptions, and removes codemode's call note from
tools that resolve to a string.
