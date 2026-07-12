# pi-tab-title

Names a Pi terminal tab from the first user message.

The extension asks the current model for a short topic label, stores it as the
session name, and uses that name as the terminal title. Existing session names
always win, and `/name <title>` sets both the session name and tab title.
