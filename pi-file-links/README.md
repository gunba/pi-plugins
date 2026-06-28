# pi-file-links

Makes bare file paths in Pi messages clickable in terminals that support OSC-8 hyperlinks.

Supports project-relative paths, absolute Linux paths, tilde paths, Windows drive
paths, UNC paths, and optional `:line` / `:line:column` suffixes. Paths with
spaces are linked when they exist on disk or when they are quoted.

The extension embeds OSC-8 file hyperlinks directly in message display text.
It strips those generated links back to plain paths before conversation history is
sent to the model.
