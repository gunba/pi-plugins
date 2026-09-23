# pi-message-timestamps

Places a small time and duration at the right edge of each Pi tool's existing
title line, inside its output block: `13:32 · <1s`. While a tool runs, a footer
status shows its start time, elapsed time and, after ten quiet seconds, the time
since activity. It refreshes every five seconds and disappears when the agent
stops. Ordinary message text is not decorated.

The extension adds no transcript rows or model content. It stores timing
metadata inside each existing tool-result record so durations survive reloads,
and hides timing rows written by the previous version. If an older result has
no timing metadata, its completion time is shown without an invented duration.
A narrow title with no space for even the time is left unchanged. The title
decoration uses Pi's bundled interactive tool component because Pi does not
expose a public renderer hook for all tools; an unsupported Pi build keeps the
live footer clock and shows a warning.

It does not run in non-interactive modes. Direct shell commands typed outside
the agent tool loop are not included.
