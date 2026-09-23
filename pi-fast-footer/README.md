# pi-fast-footer

Replaces Pi's interactive footer with a cached session summary. Lifetime token
usage, cost, session name, and context usage are read when the session leaf or
model changes, not on every terminal redraw. Git branch and extension statuses
remain live. The extension does not change model context or session files and
does not load a footer in non-interactive modes.

The public extension API does not expose Pi's automatic-compaction or
subscription-auth indicators, so this footer omits those native badges. It
does not reduce initial session loading, resident history, or `/resume` scans.
