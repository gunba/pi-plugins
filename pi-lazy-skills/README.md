# pi-lazy-skills

Pi extension that keeps Agent Skills authentic while avoiding a huge always-on skill list in the main model prompt.

On each user request, before the main agent starts, pi-lazy-skills runs a small selector call against the current model. The selector's **system prompt carries a fixed skill catalog** (names, descriptions, `SKILL.md` locations), sorted and byte-identical every turn, so it forms a stable cacheable prefix. The **per-turn user message carries only the variable tail**: the user's request plus the list of already-advised skills to exclude. The selector returns a JSON array of newly relevant skill identifiers, which the extension validates and injects as a compact custom message.

The selector call uses `cacheRetention: "short"` so the catalog prefix is reused across the session's selector calls. On OpenAI it caches automatically once the prefix clears the ~1024-token floor; on Anthropic pi-ai marks the system block `cache_control: ephemeral` for you. It deliberately avoids `"long"`, whose 1-hour Anthropic cache writes cost 2x base input tokens. The selector shares the main agent's `sessionId` purely as a routing hint — the two are independent, content-keyed cache lineages, not one shared cache.

The main agent then sees only:

```text
Skills that may be related to the user request:
- name — description
  location: /path/to/SKILL.md
```

If a listed skill looks relevant, the agent can load the authentic skill file with the normal `read` tool. Slash invocation (`/skill:name`) still works because this extension does not alter Pi's resource loader.

## Tracking

Skill advice is tracked in visible conversation state through `pi-lazy-skills-advice` custom messages. Already-advised skills are not advised again. After a compaction event, advice state resets so compacted-away skill hints may be advised again.

## Skill cutoff

If the estimated selector prefix (instructions + catalog) is below the prompt-cache floor (~1024 tokens), caching cannot engage and hiding skills saves little context, so pi-lazy-skills skips the selector entirely and leaves Pi's default skill prompt intact — all skills go in the main prompt, where they are cached anyway. Override the threshold with `PI_LAZY_SKILLS_MIN_TOKENS`.

## Failure mode

If the selector fails, times out, returns malformed/truncated output, or Pi's skill-prompt section cannot be identified safely, pi-lazy-skills fails open for that turn and leaves Pi's default skill prompt intact rather than silently hiding all skills.

## Configuration

Set `PI_LAZY_SKILLS=0`, `false`, `off`, `no`, or `disabled` to disable this extension. Any other value, or leaving the variable unset, enables it.

Set `PI_LAZY_SKILLS_MIN_TOKENS` to override the catalog-size cutoff (default `1024`) below which the selector is skipped and Pi's default skill prompt is used.
