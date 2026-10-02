"""Bounded GEPA search using Pi's native text-model runtime. No candidate execution."""
from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time

UPSTREAM_REVISION = "fb1ed589fd83372caef499cffc2c73173d3b096b"
PACKAGE_ROOT = Path(__file__).resolve().parents[4]
BRIDGE = Path(__file__).with_name("pi-model.mjs")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def positive(value, name):
    if type(value) is not int or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def private_path(value, base):
    path = (base / Path(value).expanduser()).resolve()
    if path.is_relative_to(PACKAGE_ROOT):
        raise ValueError(f"Keep run inputs and outputs outside the package: {path}")
    return path


def read_split(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list) or not data:
        raise ValueError(f"Expected a nonempty JSON array: {path}")
    if len({digest(row) for row in data}) != len(data):
        raise ValueError(f"Duplicate examples in {path}")
    return data


class PiBridge:
    def __init__(self, directory, budget):
        self.directory = directory
        self.maximum = positive(budget["max_model_calls"], "max_model_calls")
        self.deadline = time.monotonic() + positive(budget["max_seconds"], "max_seconds")
        self.request_seconds = positive(budget.get("request_seconds", 180), "request_seconds")
        self.lock = threading.RLock()
        self.pending = {}
        self.sequence = 0
        self.calls = 0
        self.total_cost = 0.0
        self.tokens = 0
        self.closed = False
        self.errors = (directory / "bridge.stderr").open("w", encoding="utf-8")
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node 22.19+ is required")
        self.process = subprocess.Popen([node, str(BRIDGE)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.errors,
                                        text=True, encoding="utf-8", bufsize=1)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                response = json.loads(line)
                with self.lock:
                    future = self.pending.pop(response["id"], None)
                if future:
                    if "error" in response:
                        future.set_exception(RuntimeError(response["error"]))
                    else:
                        future.set_result(response["result"])
        except Exception as error:
            self._reject(error)
        finally:
            self._reject(RuntimeError("Pi model bridge exited; see bridge.stderr"))

    def _reject(self, error):
        with self.lock:
            self.closed = True
            pending, self.pending = self.pending, {}
        for future in pending.values():
            future.set_exception(error)

    def request(self, op, model, prompt=None, role="check"):
        with self.lock:
            remaining = self.deadline - time.monotonic()
            if self.closed or remaining <= 0:
                raise RuntimeError("Pi bridge closed or wall-clock budget exhausted")
            if op == "complete":
                if self.calls >= self.maximum:
                    raise RuntimeError("Model-call budget exhausted")
                self.calls += 1
            self.sequence += 1
            identifier = self.sequence
            future = Future()
            self.pending[identifier] = future
            request = {"id": identifier, "op": op, "model": model,
                       "prompt": prompt, "timeoutMs": max(1, int(min(remaining, self.request_seconds) * 1000))}
            if op == "complete":
                self._record({"event": "start", "id": identifier, "role": role,
                              "model": model, "prompt": prompt})
            self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
            self.process.stdin.flush()
        try:
            result = future.result(timeout=min(remaining, self.request_seconds) + 2)
        except Exception as error:
            if op == "complete":
                with self.lock:
                    self._record({"event": "error", "id": identifier, "role": role, "error": str(error)})
            raise
        if op == "complete":
            with self.lock:
                usage = result.get("usage", {})
                self.total_cost += usage.get("cost", {}).get("total", 0) or 0
                self.tokens += usage.get("totalTokens", 0) or 0
                self._record({"event": "end", "id": identifier, "role": role, **result})
        return result

    def _record(self, record):
        with (self.directory / "model-calls.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")

    def close(self):
        self._reject(RuntimeError("Pi bridge closed"))
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.errors.close()


class PiLM:
    def __init__(self, bridge, model, role):
        self.bridge = bridge
        self.model = model
        self.role = role
        self.total_cost = 0.0
        self.total_tokens_in = 0
        self.total_tokens_out = 0
        self.lock = threading.Lock()

    def __call__(self, prompt):
        result = self.bridge.request("complete", self.model, prompt, self.role)
        with self.lock:
            usage = result.get("usage", {})
            self.total_cost += usage.get("cost", {}).get("total", 0) or 0
            self.total_tokens_in += (usage.get("input", 0) or 0) + (usage.get("cacheRead", 0) or 0)
            self.total_tokens_out += usage.get("output", 0) or 0
        return result["text"]

    def __getstate__(self):
        # GEPA's state snapshot pickles LM handles; live process/locks cannot be pickled.
        return {"total_cost": self.total_cost, "total_tokens_in": self.total_tokens_in,
                "total_tokens_out": self.total_tokens_out, "model": self.model, "role": self.role}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def verify_gepa():
    import gepa
    from importlib.metadata import distribution
    source_root = Path(gepa.__file__).resolve().parents[2]
    if (source_root / ".git").exists():
        revision = subprocess.check_output(["git", "-C", str(source_root), "rev-parse", "HEAD"], text=True).strip()
    else:
        provenance = json.loads(distribution("gepa").read_text("direct_url.json") or "{}")
        revision = provenance.get("vcs_info", {}).get("commit_id")
    if revision != UPSTREAM_REVISION:
        raise RuntimeError("GEPA revision is unverified or differs from the pin; install scripts/requirements.txt")
    return revision


def load_evaluator(path):
    spec = importlib.util.spec_from_file_location("gepa_task_evaluator", path)
    if spec is None or spec.loader is None:
        raise ValueError("Cannot load evaluator module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.evaluate


def run(config_path, preflight=False):
    config = json.loads(config_path.read_text(encoding="utf-8"))
    base = config_path.parent
    paths = {key: private_path(config[key], base) for key in
             ("seed", "train", "validation", "holdout", "evaluator", "run_dir")}
    train, validation = (read_split(paths[key]) for key in ("train", "validation"))
    if {digest(x) for x in train} & {digest(x) for x in validation}:
        raise ValueError("Training and validation examples overlap")
    budget = config["budget"]
    positive(budget["max_evals"], "max_evals")
    positive(budget["max_proposals"], "max_proposals")
    workers = positive(config.get("workers", os.cpu_count() or 1), "workers")
    seed = paths["seed"].read_text(encoding="utf-8")
    if not seed.strip():
        raise ValueError("Seed must contain text")
    # Record holdout identity without decoding its examples before candidate selection.
    frozen = {key: hashlib.sha256(paths[key].read_bytes()).hexdigest() for key in
              ("seed", "train", "validation", "holdout", "evaluator")}
    if paths["run_dir"].exists():
        raise ValueError("Use a new run_dir; automatic search resume is not supported")
    paths["run_dir"].mkdir(parents=True, mode=0o700)
    directory = paths["run_dir"]
    bridge = PiBridge(directory, budget)
    summary = {"status": "running", "upstream_revision": UPSTREAM_REVISION,
               "budget": budget, "config_sha256": hashlib.sha256(config_path.read_bytes()).hexdigest(),
               "input_sha256": frozen, "split_counts": {"train": len(train), "validation": len(validation)},
               "workers": workers, "models": {key: config.get(key) for key in ("reflection_model", "task_model")},
               "cost_basis": "Pi catalog estimate, not a provider invoice or subscription charge"}
    write_json(directory / "result.json", summary)
    started = time.monotonic()
    try:
        summary["upstream_revision"] = verify_gepa()
        checks = {key: bridge.request("check", config[key]) for key in ("reflection_model", "task_model") if config.get(key)}
        summary["preflight"] = checks
        if preflight:
            summary["status"] = "preflight"
            return summary
        from gepa.optimize_anything import optimize_anything, OptimizeAnythingConfig
        from gepa.utils.stop_condition import TimeoutStopCondition
        evaluator = load_evaluator(paths["evaluator"])
        reflection = PiLM(bridge, config["reflection_model"], "reflection")
        task = PiLM(bridge, config["task_model"], "task") if config.get("task_model") else None
        log_lock = threading.Lock()

        def evaluate(candidate, example):
            # Invalid candidate output should be scored by the evaluator. Authentication,
            # transport and budget failures propagate instead of becoming training feedback.
            score, feedback = evaluator(candidate, example, task)
            if isinstance(score, bool) or not isinstance(score, (float, int)) or not math.isfinite(score):
                raise ValueError("Evaluator score must be a finite number")
            if not isinstance(feedback, dict):
                raise ValueError("Evaluator feedback must be a dict")
            json.dumps(feedback, allow_nan=False)
            with log_lock:
                with (directory / "evaluations.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps({"candidate_sha256": digest(candidate), "example_sha256": digest(example),
                                             "score": score, "feedback": feedback}, ensure_ascii=False) + "\n")
            return float(score), feedback

        def score_split(candidate, examples):
            with ThreadPoolExecutor(max_workers=workers) as pool:
                records = list(pool.map(lambda example: evaluate(candidate, example), examples))
            return {"mean": sum(row[0] for row in records) / len(records),
                    "scores": [row[0] for row in records]}

        baseline = {key: score_split(seed, examples) for key, examples in
                    (("train", train), ("validation", validation))}
        summary["baseline"] = baseline
        write_json(directory / "result.json", summary)
        result = optimize_anything(
            seed_candidate=seed, evaluator=evaluate, dataset=train, valset=validation,
            objective=config["objective"], background=config.get("background", ""),
            config=OptimizeAnythingConfig(
                engine="gepa", max_evals=budget["max_evals"],
                max_concurrency=workers, run_dir=str(directory / "search"),
                output_dir=str(directory / "search-evaluations"),
                stop_at_score=config.get("stop_at_score"),
                engine_config={
                    "reflection": {"reflection_lm": reflection,
                                   "reflection_minibatch_size": config.get("minibatch_size", min(3, len(train)))},
                    "engine": {"max_workers": workers, "seed": config.get("seed_number", 0),
                               "max_candidate_proposals": budget["max_proposals"],
                               "cache_evaluation": False, "use_cloudpickle": False,
                               "display_progress_bar": False, "write_agent_state": True},
                    "stop_callbacks": [TimeoutStopCondition(max(0, bridge.deadline - time.monotonic()))],
                },
            ),
        )
        winner = result.best_candidate
        if not isinstance(winner, str):
            raise TypeError("Expected one text candidate")
        (directory / "winner.txt").write_text(winner, encoding="utf-8")
        proposals = [json.loads(path.read_text(encoding="utf-8")) for path in
                     (directory / "search" / "iterations").glob("*/meta.json") if path.parent.name != "seed"]
        if config.get("stop_at_score") is not None and result.best_score >= config["stop_at_score"]:
            stop_reason = "score_threshold"
        elif result.total_evals >= budget["max_evals"]:
            stop_reason = "search_eval_budget"
        elif len(proposals) >= budget["max_proposals"]:
            stop_reason = "proposal_budget"
        elif time.monotonic() >= bridge.deadline:
            stop_reason = "wall_clock_budget"
        else:
            stop_reason = "engine_stopped"
        summary["search"] = {"best_validation_score": result.best_score,
                             "validation_scores": result.val_aggregate_scores,
                             "candidate_pool_count": len(result.candidates), "best_idx": result.best_idx,
                             "proposal_attempts": len(proposals),
                             "accepted_proposals": sum(bool(row.get("accepted")) for row in proposals),
                             "stop_reason": stop_reason, "search_evals": result.total_evals,
                             "winner_sha256": digest(winner), "changed": winner != seed}
        write_json(directory / "candidate-pool.json", result.to_dict())
        write_json(directory / "result.json", summary)
        # Search is over. Freeze the winner before opening holdout or showing its feedback.
        for key, expected in frozen.items():
            if hashlib.sha256(paths[key].read_bytes()).hexdigest() != expected:
                raise ValueError(f"Input changed during search: {key}")
        holdout = read_split(paths["holdout"])
        hashes = {digest(x) for x in holdout}
        if hashes & ({digest(x) for x in train} | {digest(x) for x in validation}):
            raise ValueError("Holdout overlaps training or validation")
        summary["split_counts"]["holdout"] = len(holdout)
        summary["holdout"] = {"baseline": score_split(seed, holdout),
                              "winner": score_split(winner, holdout)}
        summary["status"] = "complete"
        return summary
    except BaseException as error:
        summary["status"] = "failed"
        summary["error"] = str(error)
        raise
    finally:
        summary["model_calls"] = bridge.calls
        summary["catalog_cost_estimate"] = bridge.total_cost
        summary["total_tokens"] = bridge.tokens
        summary["elapsed_seconds"] = time.monotonic() - started
        write_json(directory / "result.json", summary)
        bridge.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--preflight", action="store_true", help="Check native model/auth access without a completion")
    args = parser.parse_args()
    path = private_path(str(args.config.resolve()), Path.cwd())
    result = run(path, args.preflight)
    print(json.dumps({"status": result["status"], "model_calls": result["model_calls"],
                      "search": result.get("search"), "holdout": result.get("holdout")}, indent=2))


if __name__ == "__main__":
    main()
