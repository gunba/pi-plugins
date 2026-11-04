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

```

Pi's own `<cwd>` section carries the folder. The tool versions are probed once per
process, so the section only changes when the computer or the registered tools do,
which keeps the prompt cache.

## Instructions for other folders

Pi loads `AGENTS.md` (and `AGENTS.override.md`, `CLAUDE.md`) from the folder a
conversation started in and the folders above it. When the agent reads, edits or
writes a file elsewhere, `folder-instructions.ts` adds the instructions of that file's
folder and the folders above it that Pi didn't load, once each, after the tool's
result. In a program they follow the program's output, so the file data the program
reads is unchanged. Being tool output, they keep the prompt cache; after a compaction
they are added again when next needed. Each file is cut at 24,000 characters.

## Prompt sections

The extension also replaces Pi's documentation section with a one-line pointer,
drops rules that repeat tool descriptions, and removes codemode's call note from
tools that resolve to a string.
