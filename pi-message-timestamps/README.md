# pi-message-timestamps

Records tool start/end times in native tool-result details. In the terminal,
a footer clock shows the active tool's start time, elapsed time and, after ten
quiet seconds, the time since activity. It refreshes every five seconds and
clears when the agent settles. Ordinary message text is not decorated.

Timing capture works in terminal, RPC and SDK sessions without adding transcript
rows or model content. Pi Desk reads those details when displaying saved tool
durations. Unknown starts are not reported as zero-duration executions, and
non-object tool details are preserved without replacement.

The extension uses public lifecycle events, not Pi's private terminal renderer.
Generic inline tool-title decoration is no longer attempted; Pi has no public
hook for decorating every tool's title. Direct shell commands outside the agent
tool loop are not included.
