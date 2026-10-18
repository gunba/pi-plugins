import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = process.env.REVIEW_CORPUS_DIR || join(homedir(), ".cache", "pi-code-review");

export const REPOS = {
  // Projects whose line-level review happens on GitHub pull requests.
  github: [
    "llvm/llvm-project", "rust-lang/rust", "python/cpython", "kubernetes/kubernetes",
    "openjdk/jdk", "WebKit/WebKit", "systemd/systemd", "bytecodealliance/wasmtime",
    "microsoft/TypeScript", "nodejs/node", "dotnet/runtime", "tokio-rs/tokio",
    "bitcoin/bitcoin", "envoyproxy/envoy", "django/django", "numpy/numpy",
    "swiftlang/swift", "pytorch/pytorch", "openssl/openssl", "duckdb/duckdb",
    "facebook/react", "astral-sh/ruff", "etcd-io/etcd",
  ],
  // Mailing lists archived on lore.kernel.org: list -> newest public-inbox epoch.
  lore: {
    "linux-mm": 2, netdev: 3, bpf: 0, "linux-fsdevel": 1, "rust-for-linux": 0,
    "io-uring": 0, "linux-block": 0, kvm: 1, git: 1,
  },
  // Gerrit hosts with open REST APIs.
  gerrit: { go: "https://go-review.googlesource.com" },
};
