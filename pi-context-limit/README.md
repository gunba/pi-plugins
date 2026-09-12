# Context limit

```text
/context-limit
/context-limit 160k
/context-limit 200000
```

The command adjusts Pi's native automatic compaction reserve. For example,
200k with a 272,000-token model window writes a 72,000-token reserve.
It waits for the current run to become idle, updates only that setting under
the native settings lock, and reloads extensions automatically. No Pi restart
is needed. A reload also applies Pi's usual lifecycle rules, including
disarming autonomous goals and restored party delivery.

This is an approximate compaction threshold, not an input-token rejection
limit. The reserve is global; another model window produces a different
threshold. Other running processes read the change when they reload.
A trusted workspace reserve override must be resolved before changing the
global value. The command does not enable compaction if it was disabled.

No model metadata, Pi runtime files or saved session entries are altered.
