# pi-show

Lets agents show their work in Pi Desk.

## Computed changes

Before a tool call runs, the extension keeps a copy of the files it may change:

- the file named by `write` or `edit`;
- spreadsheets, Word documents and slide decks (`.xlsx`, `.xlsm`, `.docx`, `.docm`, `.pptx`, `.pptm`) that a command names, directly or inside a script it runs.

After the call, it compares each file with its copy and adds the difference to the tool result's `details`. This is cell by cell for spreadsheets (values and formulas), paragraph by paragraph for documents, slide by slide for decks, and line by line for text written with `write`. The model never sees these details, so they cost no context.

The first version of each file a conversation touches is kept for 30 days under `~/.pi/agent/show/<session>/`.

## The `show` tool

Agents call `show` at key moments, with a title, an optional Markdown note and up to 12 items. Each item names a file, a part of it, or changes in the agent's own words. Desk then displays:

- images inline;
- spreadsheets as a table of the range;
- documents and decks as text;
- HTML files as a live page, for tables, charts and other rich displays: its inline scripts and styles run in a
  sandboxed frame with no network access and no access to Desk;
- text files as an excerpt.

For a file the conversation has changed, Desk shows its changes since the agent first touched it. When the agent lists spreadsheet changes, Desk checks them against the file and reports changed cells the agent did not mention, to the agent as well as to the user.

Office files are read with Node's zlib: no Office installation or Python packages are needed.
