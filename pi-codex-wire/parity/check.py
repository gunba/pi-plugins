#!/usr/bin/env python3
"""What changed in Codex's request code since the release Codex Wire last matched.

    python3 check.py [baseline-tag]        # default: the tag in ~/codex-parity/baseline, else rust-v0.164.0

Prints the latest stable Codex release and, when it is newer than the baseline, each changed file among those that
shape what Codex sends to the Responses API (PATHS), with its line counts and the changed lines that declare fields,
types, headers or metadata. The output changes only when a release does, so a watch that re-runs it wakes once per
release, and its wake_when (judged by a classifier, which reads the last 4,000 characters) decides whether the change
matters. Network errors print a line that also changes nothing, so a failed run wakes no one.

Codex's sources are kept in a partial clone at ~/codex-parity/codex: tags and history, with file contents fetched
only for the files a diff reads.
"""
import json, os, re, subprocess, sys, urllib.error, urllib.request

HOME = os.path.expanduser("~/codex-parity")
REPO = os.path.join(HOME, "codex")
LIMIT = 3_800
# Where Codex 0.165.0 builds model requests: bodies, headers, turn and client metadata, input items, tool
# declarations, the websocket transport, remote compaction and authentication. Revisit when Codex moves them.
PATHS = [
    "codex-rs/core/src/client.rs", "codex-rs/core/src/client_common.rs", "codex-rs/core/src/client_tool_metadata.rs",
    "codex-rs/core/src/turn_metadata.rs", "codex-rs/core/src/responses_metadata.rs", "codex-rs/core/src/installation_id.rs",
    ":(glob)codex-rs/core/src/compact_remote*.rs", "codex-rs/core/src/context_manager",
    "codex-rs/codex-api/src/requests", "codex-rs/codex-api/src/endpoint/responses.rs",
    ":(glob)codex-rs/codex-api/src/endpoint/responses_websocket*", "codex-rs/codex-api/src/responses_headers.rs",
    "codex-rs/codex-api/src/sse/responses.rs", "codex-rs/codex-api/src/sse/responses_error.rs",
    "codex-rs/codex-api/src/error.rs", "codex-rs/codex-api/src/api_bridge.rs",
    "codex-rs/codex-api/src/auth.rs", "codex-rs/codex-api/src/provider.rs",
    "codex-rs/model-provider/src", "codex-rs/models-manager/src",
    "codex-rs/protocol/src/models.rs", "codex-rs/protocol/src/models", "codex-rs/protocol/src/openai_models.rs",
    "codex-rs/protocol/src/openai_models", "codex-rs/protocol/src/response_item_id.rs",
    "codex-rs/login/src/auth", "codex-rs/tools/src/tool_spec.rs",
]
SKIP = re.compile(r"(^|/)tests?(/|\.rs$)|_tests?\.rs$|\.snap$")
# Changed lines that say what goes over the wire.
WIRE = re.compile(r"#\[serde|pub (struct|enum|type)|header|\"x-|\"[a-z_]+\"|json!|metadata|session_id|thread_id|turn_id|"
                  r"window|prompt_cache|reasoning|include|service_tier|instructions|tool|originator|user[-_]agent|websocket|"
                  r"compact|encrypted|previous_response|store\b|stream\b|beta|version|passthrough|item_kind", re.I)


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", REPO, *args], check=True, capture_output=True, text=True, timeout=600).stdout


def latest_release() -> str:
    request = urllib.request.Request("https://api.github.com/repos/openai/codex/releases/latest",
                                     headers={"Accept": "application/vnd.github+json", "User-Agent": "codex-wire-parity"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)["tag_name"]


def main() -> None:
    default = os.path.join(HOME, "baseline")
    baseline = sys.argv[1] if len(sys.argv) > 1 else open(default).read().strip() if os.path.exists(default) else "rust-v0.164.0"
    try:
        latest = latest_release()
    except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as error:
        print(f"Could not read the latest release ({type(error).__name__}).")
        return
    if latest == baseline:
        print(f"The latest stable release, {latest}, is the baseline: nothing to compare.")
        return
    try:
        if not os.path.isdir(REPO):
            os.makedirs(HOME, exist_ok=True)
            subprocess.run(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", "https://github.com/openai/codex", REPO],
                           check=True, capture_output=True, timeout=1800)
        git("fetch", "-q", "--tags", "--force", "origin")
        stats = git("diff", "--numstat", baseline, latest, "--", *PATHS)
        patch = git("diff", "-U0", baseline, latest, "--", *PATHS)
    except (subprocess.SubprocessError, OSError) as error:
        print(f"New release {latest} (baseline {baseline}); its sources could not be compared ({type(error).__name__}).")
        return
    counts = {}
    for line in stats.splitlines():
        added, removed, path = line.split("\t", 2)
        if not SKIP.search(path): counts[path] = (added, removed)
    changed: dict[str, list[str]] = {path: [] for path in counts}
    current = None
    for line in patch.splitlines():
        if line.startswith("diff --git "): current = line.split(" b/", 1)[-1]
        elif current in changed and line[:1] in "+-" and not line.startswith(("+++", "---")) and WIRE.search(line):
            changed[current].append(line.strip()[:160])
    head = (f"New stable release {latest}; Codex Wire matches {baseline}. "
            f"{len(counts)} of the files that build model requests changed." if counts else
            f"New stable release {latest}; Codex Wire matches {baseline}. None of the files that build model requests changed.")
    # The classifier reads the end, so the files with the most wire-related changes come last.
    entries = [f"\n{path} (+{counts[path][0]} -{counts[path][1]})" + "".join(f"\n  {line}" for line in lines[:15])
               for path, lines in sorted(changed.items(), key=lambda item: len(item[1]))]
    text = head + "".join(entries)
    print(text if len(text) <= LIMIT else head + "\n…" + text[-(LIMIT - len(head) - 2):])


if __name__ == "__main__":
    main()
