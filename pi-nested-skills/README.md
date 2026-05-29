# pi-nested-skills

Global Pi extension that lets skills declare logical parent/child relationships using portable Agent Skills frontmatter metadata.

Local install location:

`C:\Users\Jordan.Graham\.pi\agent\extensions\pi-nested-skills\index.ts`

Run `/reload` or restart Pi to load local changes.

Package install from the private repo:

```bash
pi install git:https://github.com/gunba/pi-nested-skills
```

Portable repo working copy:

`C:\Obsidian\Tools\pi-plugins\pi-nested-skills`

## What it does

Pi normally presents skills as a flat `<available_skills>` list. This extension reads the frontmatter of the skills Pi has already loaded and detects metadata values that match the name of another loaded skill.

When relationships exist, the default mode (`defer`) rewrites Pi's system-prompt skill list so parent/root skills are shown upfront with compact child names:

- parent skills remain top-level in Pi, even if marked `disable-model-invocation: true` for other clients;
- child skill names are listed under their parent in the initial Pi prompt;
- child descriptions and `SKILL.md` locations are deferred;
- the `nested_skill_children` tool returns compact Markdown with child descriptions and paths on demand;
- child skills keep their own `/skill:name` command and `SKILL.md` location;
- no skill file content is changed at runtime.

This keeps the skill files compatible with Claude Code, Codex, and any other Agent Skills client that ignores unknown metadata.

## Portable frontmatter schema

Preferred child schema:

```yaml
---
name: rd-core
description: Draft an R&D Tax Incentive Core Activity narrative...
metadata:
  parent_skill: rdtax
---
```

Optional parent/category schema. Clients that implement `disable-model-invocation` hide the category skill from their normal skill list; Pi's plugin still renders it as a parent when children point to it:

```yaml
---
name: rdtax
description: Parent/category skill for R&D Tax Incentive workflows...
disable-model-invocation: true
---
```

Multiple parents:

```yaml
metadata:
  parent_skills:
    - rdtax
    - rsm-branding
```

Generic tags also work. Only tags that exactly match another loaded skill name create a nesting relationship; other tags are ignored by this extension.

```yaml
metadata:
  tags:
    - rdtax
    - drafting
```

Supported keys under `metadata`:

- `parent_skill`, `parent_skills`
- `parent`, `parents`
- `skill_parent`, `skill_parents`
- `category_skill`, `category_skills`
- `category`, `categories`
- `tagged_with`
- `skill_tags`
- `tags`
- `skills`

Top-level aliases are parsed for convenience, but `metadata` is preferred because it is part of the Agent Skills frontmatter spec and is safest for interoperability.

## Modes

Set `PI_NESTED_SKILLS_MODE` before launching Pi:

- `defer` (default): replace the flat `<available_skills>` prompt block with root/parent skills plus child names only; child descriptions and paths can be requested with `nested_skill_children`.
- `collapse`: replace the flat `<available_skills>` prompt block with a full nested version including child names/descriptions.
- `map`: leave Pi's flat skill list untouched and append a small `Nested Skill Map` section.
- `off`: disable the extension without moving files.

## Tool

- `nested_skill_children` - model-callable tool that returns compact Markdown child skill details for a parent skill. Omit `parent` to list parent groups.

## Commands

- `/pi-nested-skills status` - show detected parent/child relationships.
- `/pi-nested-skills schema` - show the portable frontmatter examples.

## Current local tagging

This machine currently tags first-party/local children under: `rdtax`, `daily`, `github`, `gmail`, `ato-mcp-server`, `r`, and `j`.

## Notes

- Relationships are routing hints only, not authority or dependency rules.
- In `defer` mode, if a parent category matches a task, the agent can see child names immediately and should call `nested_skill_children` for descriptions and paths before choosing what to read.
- If a user explicitly invokes `/skill:child-name`, Pi still loads that child skill directly because slash commands and skill discovery are unchanged.
- The extension only changes Pi's prompt presentation. It does not modify skill discovery, skill files, slash commands, or other clients.
