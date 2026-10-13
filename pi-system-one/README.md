# System One

Adds a short paragraph to the system prompt, when codemode is active, telling
the agent that System One classifier models exist and when they help: the same
judgement over many items. The agent calls them itself with codemode's
`models.classify` and builds the requests however the task needs.

TypeSafe's Jev needs `/login typesafe` or `TYPESAFE_API_KEY`. Other classifiers,
listed by `models.getAvailableOfType("classifier")`, work the same way.
