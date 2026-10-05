#!/usr/bin/env python3
"""Hosted Qwen3 embeddings and local outcome-separated UMAP/HDBSCAN."""
import concurrent.futures
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

MODEL = "Qwen/Qwen3-Embedding-4B"
ENDPOINT = "https://api.deepinfra.com/v1/openai/embeddings"
PRICE_PER_MILLION_TOKENS = 0.02
PRICE_SOURCE = "https://deepinfra.com/Qwen/Qwen3-Embedding-4B/api"


def dependencies():
    versions = {}
    for line in Path(__file__).with_name("requirements.txt").read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        name, expected = line.split("==")
        actual = importlib.metadata.version(name)
        if actual != expected:
            raise RuntimeError(f"{name}: expected {expected}, found {actual}")
        versions[name] = actual
    import hdbscan  # noqa: F401
    import numpy  # noqa: F401
    import umap  # noqa: F401
    return versions


def api_key():
    key = os.environ.get("DEEPINFRA_API_KEY", "").strip()
    if not key or any(not 33 <= ord(character) <= 126 for character in key):
        raise RuntimeError("Set DEEPINFRA_API_KEY in the Pi process environment to a valid API key")
    return key


def request(payload, key):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise RuntimeError("Embedding endpoint redirect refused")

    opener = urllib.request.build_opener(urllib.request.ProxyHandler(), NoRedirect())
    req = urllib.request.Request(ENDPOINT, data=json.dumps(payload).encode(), headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {key}",
    })
    try:
        with opener.open(req, timeout=120) as response:
            body = response.read(32 * 1024 * 1024 + 1)
            if len(body) > 32 * 1024 * 1024:
                raise RuntimeError("Embedding response too large")
            return json.loads(body)
    except urllib.error.HTTPError as error:
        # Do not echo provider response bodies, request inputs or credentials into tool errors.
        hint = "Check DEEPINFRA_API_KEY and account access." if error.code in (401, 403) else "Check DeepInfra availability, quota and input limits."
        raise RuntimeError(f"DeepInfra embeddings returned HTTP {error.code}. {hint}") from None


def embed_batch(texts, key):
    response = request({"model": MODEL, "input": texts, "encoding_format": "float"}, key)
    if not isinstance(response, dict) or response.get("model") != MODEL:
        raise RuntimeError("Unexpected embedding response model")
    data = response.get("data")
    if not isinstance(data, list) or len(data) != len(texts):
        raise RuntimeError("Incomplete embedding response")
    indices = [item.get("index") if isinstance(item, dict) else None for item in data]
    if any(type(index) is not int for index in indices) or set(indices) != set(range(len(texts))):
        raise RuntimeError("Invalid embedding response indices")
    vectors = [item.get("embedding") for item in sorted(data, key=lambda item: item["index"])]
    usage = response.get("usage", {})
    tokens = usage.get("prompt_tokens") if isinstance(usage, dict) else None
    if type(tokens) is not int or tokens < 0:
        tokens = None
    return vectors, tokens


def cluster_partition(items, key):
    import hdbscan
    import numpy as np
    import umap

    ids = [item["traceId"] for item in items]
    # UMAP cannot establish a density structure with fewer than three samples.
    if len(ids) < 3:
        return {"ids": ids, "labels": [-1] * len(ids), "embeddingRequests": 0, "promptTokens": 0,
                "reason": "fewer than three observed outcomes in partition"}
    vectors, token_counts = [], []
    for offset in range(0, len(items), 8):
        batch = items[offset:offset + 8]
        embeddings, tokens = embed_batch([item["summary"] + "\n" + "\n".join(item["observations"]) for item in batch], key)
        vectors.extend(embeddings)
        token_counts.append(tokens)
    matrix = np.asarray(vectors, dtype=float)
    if matrix.ndim != 2 or not matrix.shape[1] or not np.isfinite(matrix).all():
        raise RuntimeError("Invalid embedding vectors")
    norms = np.linalg.norm(matrix, axis=1)
    if (norms == 0).any():
        raise RuntimeError("Zero embedding vector")
    matrix /= norms[:, None]
    components = min(20, len(ids) - 2)
    neighbors = min(15, len(ids) - 1)
    reduced = umap.UMAP(n_components=components, n_neighbors=neighbors, min_dist=0.1,
                        metric="cosine", random_state=42, n_jobs=1, low_memory=False).fit_transform(matrix)
    labels = hdbscan.HDBSCAN(min_cluster_size=2, min_samples=1, metric="euclidean",
                            cluster_selection_method="eom", core_dist_n_jobs=-1).fit_predict(reduced)
    return {"ids": ids, "labels": labels.tolist(), "embeddings": vectors,
            "embeddingRequests": len(token_counts),
            "promptTokens": sum(token_counts) if all(tokens is not None for tokens in token_counts) else None,
            "components": components, "neighbors": neighbors}


def main():
    config = json.load(sys.stdin)
    key = api_key()
    versions = dependencies()
    metadata = {"provider": "deepinfra", "model": MODEL, "endpoint": ENDPOINT, "versions": versions,
                "credentialConfigured": True, "credentialValidated": False,
                "pricePerMillionInputTokensUsd": PRICE_PER_MILLION_TOKENS, "priceSource": PRICE_SOURCE,
                "umap": {"metric": "cosine", "components": 20, "neighbors": 15, "minDist": 0.1, "seed": 42},
                "hdbscan": {"metric": "euclidean", "minClusterSize": 2, "minSamples": 1, "selection": "eom"}}
    if config.get("preflight"):
        print(json.dumps(metadata))
        return
    summaries = config["summaries"]
    partitions = [(outcome, [item for item in summaries if item["outcome"] == outcome]) for outcome in ("success", "failure")]
    clusters, noise, results = [], [], {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = {outcome: pool.submit(cluster_partition, items, key) for outcome, items in partitions}
        for outcome, _ in partitions:
            result = futures[outcome].result()
            results[outcome] = result
            for label in sorted(set(result["labels"])):
                members = [tid for tid, assigned in zip(result["ids"], result["labels"], strict=True) if assigned == label]
                if label < 0 or len(members) < 2:
                    noise.extend(members)
                else:
                    clusters.append({"id": f"{outcome}-{label}", "outcome": outcome, "traceIds": members})
    token_counts = [result["promptTokens"] for result in results.values()]
    tokens = sum(token_counts) if all(count is not None for count in token_counts) else None
    requests = sum(result["embeddingRequests"] for result in results.values())
    metadata["credentialValidated"] = requests > 0
    metadata["usage"] = {"requests": requests, "promptTokens": tokens,
                         "estimatedUsd": tokens * PRICE_PER_MILLION_TOKENS / 1_000_000 if tokens is not None else None}
    print(json.dumps({"clusters": clusters, "noise": noise, "metadata": metadata, "partitions": results}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
