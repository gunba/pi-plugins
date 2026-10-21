import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = process.env.CRAFT_CORPUS_DIR || join(homedir(), ".cache", "pi-code-craft");
// Raw changes already fetched for the code-review corpus are read from here
// instead of fetched again.
export const REUSE_DIR = process.env.REVIEW_CORPUS_DIR || join(homedir(), ".cache", "pi-code-review");

// Line-level review on GitHub pull requests.
export const GITHUB = {
  // The code-review corpus's projects; more of their changes are sampled.
  review: [
    "llvm/llvm-project", "rust-lang/rust", "python/cpython", "kubernetes/kubernetes",
    "openjdk/jdk", "WebKit/WebKit", "systemd/systemd", "bytecodealliance/wasmtime",
    "microsoft/TypeScript", "nodejs/node", "dotnet/runtime", "tokio-rs/tokio",
    "bitcoin/bitcoin", "envoyproxy/envoy", "django/django", "numpy/numpy",
    "swiftlang/swift", "pytorch/pytorch", "openssl/openssl", "duckdb/duckdb",
    "astral-sh/ruff", "etcd-io/etcd",
  ],
  // Projects known for their test suites and review of tests.
  added: [
    "pytest-dev/pytest", "cockroachdb/cockroach", "prometheus/prometheus", "rust-lang/cargo",
    "microsoft/vscode", "angular/angular", "facebook/react", "ClickHouse/ClickHouse",
    "apache/kafka", "scikit-learn/scikit-learn", "pandas-dev/pandas", "python/mypy",
    "curl/curl", "neovim/neovim", "containerd/containerd", "rust-lang/rust-analyzer",
    "vitest-dev/vitest", "apache/arrow", "grpc/grpc-go", "denoland/deno",
  ],
  // Changes written by coding agents, reviewed by people.
  agents: [
    ...["dotnet/runtime", "dotnet/aspnetcore", "dotnet/roslyn", "dotnet/maui", "dotnet/sdk",
      "dotnet/efcore", "microsoft/vscode", "microsoft/typescript-go", "Azure/azure-sdk-for-net"]
      .map(repo => ({ repo, q: "author:app/copilot-swe-agent", tag: "copilot" })),
    { repo: null, q: '"Generated with Claude Code" in:body', tag: "claude-code" },
    { repo: null, q: '"chatgpt.com/codex" in:body', tag: "codex" },
  ],
};

// Mailing lists archived on lore.kernel.org: list -> newest public-inbox epoch.
export const LORE = { "linux-kselftest": 0, fstests: 0, git: 1 };

// Gerrit hosts with open REST APIs.
export const GERRIT = {
  "https://go-review.googlesource.com": ["go", "tools", "crypto", "net"],
  "https://chromium-review.googlesource.com": ["chromium/src"],
};
