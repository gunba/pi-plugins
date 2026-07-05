# pi-sync

Syncs the user's Pi setup directory (`~/.pi`) through git.

## Commands

- `/pi-sync status` — show repository state and remote.
- `/pi-sync init [remote-url]` — initialize `~/.pi` as a git repo, install the managed `.gitignore`, and optionally set `origin`.
- `/pi-sync bootstrap <remote-url>` — first-time setup on another machine:
  initialize `~/.pi`, back up local files that the remote tracks, check out the
  remote setup, and update Pi packages.
- `/pi-sync pull` — fast-forward from the configured remote.
- `/pi-sync push [message]` — stage, commit, and push setup changes.
- `/pi-sync sync [message]` — commit local setup changes, rebase onto the remote, and push.
- `/pi-sync remote <url>` — set the `origin` remote.
- `/pi-sync ignore` — refresh the managed `.gitignore` block.

The managed ignore rules keep generated package installs, sessions, caches, temporary files, and local auth state machine-local. Installable packages stay represented by `settings.json`, so `pi update --extensions` can recreate them on another machine.
