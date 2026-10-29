#!/usr/bin/env python3
"""Compare structural capture evidence; report differences without equating Pi's prompt or tool text to Codex's."""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(sys.argv[1])
SUMMARY = json.loads((ROOT / "summary.json").read_text())["summaries"]
assert SUMMARY, "No capture scenarios completed"
for row in SUMMARY:
    terminal = "model-not-found" in row["name"] or "policy-capacity" in row["name"] and "policy-capacity-retry" not in row["name"]
    expected = 1 if row["name"].startswith("native-") and terminal else 0
    assert row["code"] == expected and row["signal"] is None, row
    if "missing-ids" in row["name"]:
        assert row.get("resume") == {"code": 0, "signal": None}, row
    assert (ROOT / (row["name"] + ".jsonl")).is_file(), row
HARNESS = ("host_skills", "permissions", "collaboration_mode", "multi_agent", "environments")
IDENTITY = {"installation_id", "session_id", "thread_id", "turn_id", "window_id", "context_window_id", "root_turn_id", "turn_started_at_unix_ms"}
UUID7 = re.compile(r"^(rs|fc|msg)_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def load(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def requests(records):
    return [row["body"] for row in records if row["kind"] == "websocket" or row["kind"] == "http" and row.get("method") == "POST"]


def metadata(body):
    value = json.loads(body.get("client_metadata", {}).get("x-codex-turn-metadata", "{}"))
    return {key: "<identity/time>" if key in IDENTITY else item for key, item in value.items() if key != "turn_trigger"}


def item_shapes(body):
    result = []
    for item in body.get("input", []):
        passthrough = item.get("internal_chat_message_metadata_passthrough", {})
        kinds = passthrough.get("content_item_kinds", [])
        if kinds and all(kind.startswith(HARNESS) for kind in kinds):
            continue
        result.append({"type": item.get("type"), "role": item.get("role"), "keys": list(item),
                       "passthrough": list(passthrough), "kinds": kinds})
    return result


result = {"pairs": [], "checks": []}
for native_path in sorted(ROOT.glob("native-*.jsonl")):
    name = native_path.stem.removeprefix("native-")
    native, wire = load(native_path), load(ROOT / ("wire-" + name + ".jsonl"))
    left, right = requests(native), requests(wire)
    differences = []
    assert len(left) == len(right), (name, len(left), len(right))
    for index, (a, b) in enumerate(zip(left, right)):
        projections = {
            "field_order": (list(a), list(b)),
            "client_metadata_keys": (sorted(a.get("client_metadata", {})), sorted(b.get("client_metadata", {}))),
            "turn_metadata_order": (list(metadata(a)), list(metadata(b))),
            "turn_metadata_values": (metadata(a), metadata(b)),
            "input_shapes": (item_shapes(a), item_shapes(b)),
        }
        for field, (before, after) in projections.items():
            if before != after:
                differences.append({"request": index, "field": field, "native": before, "wire": after})
    header_names = lambda rows: sorted({key for row in rows if row["kind"] in {"http", "upgrade"} for key in row.get("headers", {})})
    native_headers, wire_headers = header_names(native), header_names(wire)
    if native_headers != wire_headers:
        differences.append({"field": "header_names", "native_only": sorted(set(native_headers) - set(wire_headers)),
                            "wire_only": sorted(set(wire_headers) - set(native_headers))})
    if "missing-ids" in name:
        for client, bodies in [("native", left), ("wire", right)]:
            assert metadata(bodies[-1])["history_initialization"] == "cold_resume", (client, name)
            replay = [item for item in bodies[-1]["input"] if item.get("type") in {"reasoning", "function_call"} or item.get("role") == "assistant"]
            assert [item["type"] for item in replay] == ["reasoning", "function_call", "reasoning", "message"], (client, name, replay)
            assert all(UUID7.fullmatch(item.get("id", "")) for item in replay), (client, name, replay)
            assert replay[1]["call_id"] == "call_capture"
            if name.endswith("sse"):
                prior = [item for item in bodies[1]["input"] if item.get("type") in {"reasoning", "function_call"}]
                assert [item["id"] for item in prior] == [item["id"] for item in replay[:2]], (client, name)
            if client == "wire":
                saved = [row["message"] for row in load(ROOT / ("wire-" + name + ".stdout")) if row.get("type") == "message_end" and row.get("message", {}).get("role") == "assistant"]
                ids = []
                for message in saved:
                    for block in message["content"]:
                        if block["type"] == "thinking": ids.append(json.loads(block["thinkingSignature"])["id"])
                        elif block["type"] == "text": ids.append(json.loads(block["textSignature"])["id"])
                        elif block["type"] == "toolCall": ids.append(block["id"].split("|")[1])
                assert ids == [item["id"] for item in replay], (client, name)
        result["checks"].append(name + ": generated UUIDv7 IDs persist through cold resume; Wire replay equals saved output")
    if "model-not-found" in name:
        for client in ["native", "wire"]:
            events = load(ROOT / (client + "-" + name + ".stdout"))
            if client == "native":
                assert any(row.get("type") == "turn.failed" and row["error"]["message"] == "Capture model is unavailable." for row in events)
            else:
                assert any(row.get("type") == "message_end" and row.get("message", {}).get("stopReason") == "error" and row["message"]["errorMessage"] == "Capture model is unavailable." for row in events)
        assert sum(body.get("generate") is not False for body in left) == 1
        result["checks"].append(name + ": terminal model_not_found, no inference retry")
    if "policy-capacity" in name:
        advised = "policy-capacity-retry" in name
        for client, bodies in [("native", left), ("wire", right)]:
            assert sum(body.get("generate") is not False for body in bodies) == (2 if advised else 1), (client, name)
            assert all(body["model"] == "gpt-6-astra" for body in bodies), (client, name)
            events = load(ROOT / (client + "-" + name + ".stdout"))
            if client == "native":
                if advised:
                    assert any(row.get("type") == "turn.completed" for row in events), name
                else:
                    assert any(row.get("type") == "turn.failed" and row["error"]["message"] == "Policy-restricted capacity is unavailable. Please try again later." for row in events), name
            else:
                messages = [row["message"] for row in events if row.get("type") == "message_end" and row.get("message", {}).get("role") == "assistant"]
                assert messages[-1]["stopReason"] == ("stop" if advised else "error"), name
                if not advised:
                    assert messages[-1]["errorMessage"] == "Policy-restricted capacity is unavailable. Please try again later.", name
        result["checks"].append(name + ": retry only with server advice; no model switch")
    result["pairs"].append({"name": name, "requests_per_client": len(left), "differences": differences})
print(json.dumps(result, indent=2))
