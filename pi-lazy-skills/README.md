# pi-lazy-skills

Pi extension that keeps Agent Skills authentic while avoiding a huge always-on skill list in the main model prompt.

On each user request, before the main agent starts, pi-lazy-skills runs a small selector call against the current model. The selector sees skill names/descriptions and the user's request, and must return only a JSON array of skill identifiers. The selector call uses `cacheRetention: "none"` because its prompt is ephemeral. The extension validates those identifiers and injects a compact custom message containing the matching skill descriptions and `SKILL.md` locations.

The main agent then sees only:

```text
Skills that may be related to the user request:
- name — description
  location: /path/to/SKILL.md
```

If a listed skill looks relevant, the agent can load the authentic skill file with the normal `read` tool. Slash invocation (`/skill:name`) still works because this extension does not alter Pi's resource loader.

## Tracking

Skill advice is tracked in visible conversation state through `pi-lazy-skills-advice` custom messages. Already-advised skills are not advised again. After a compaction event, advice state resets so compacted-away skill hints may be advised again.

## Failure mode

If the selector fails, times out, returns malformed/truncated output, or Pi's skill-prompt section cannot be identified safely, pi-lazy-skills fails open for that turn and leaves Pi's default skill prompt intact rather than silently hiding all skills.

## Configuration

Set `PI_LAZY_SKILLS=0`, `false`, `off`, `no`, or `disabled` to disable this extension. Any other value, or leaving the variable unset, enables it.
