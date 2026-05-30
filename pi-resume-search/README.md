# pi-resume-search

Full-session text search for Pi session resume.

Adds:

- `/resume-search [query]` — open a resume picker that searches parsed session JSONL content.
- `/rs [query]` — short alias.

The picker keeps Pi's resume controls (`Tab` scope, `Ctrl+S` sort, `Ctrl+N` named, `Ctrl+P` path, `Ctrl+R` rename, `Ctrl+D` delete) and displays match snippets as `role #entry age · …matched text…` instead of raw JSON.
