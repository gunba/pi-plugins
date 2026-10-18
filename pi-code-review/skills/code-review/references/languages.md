# Checks by language and ecosystem

What top reviewers in each ecosystem look for, on top of the general
checklist in `SKILL.md`. They come from recurring comments that changed the
code. Read the sections that match the change; `node scripts/examples.mjs
--project <name>` shows the comments behind them.

**Everywhere.** Concurrency gets less review than it deserves in every
language: few comments touch it, but those that do are among the most
serious. If the change touches shared state, do the concurrency pass even when
the change does not look concurrent. In Python projects, the reverse holds for
tests: reviewers comment on them often, but rarely about anything that
matters.

**C and C++ systems code.** Error unwinding (`goto` ladders, RAII on every
exit, including exceptions and panics through FFI); ownership-transfer APIs
(`set0`, `release`, `take`) followed by a free on the error path; classes
holding pointers into themselves that still have implicit copy or move;
integer widths in size arithmetic; `errno` or last-error read after another
call; memory ordering on publication (release store before the reader's
acquire load); lock scope around callbacks and syncs.

**Linux kernel.** Lock ordering and sleeping in atomic context (allocation
flags, `copy_from_user` under a spinlock or `mmap_lock`); reference counts
across error paths; RCU readers and the lifetime of what they dereference;
helpers that touch task-private state called from io-wq or SQPOLL context;
behaviour changes hidden in "cleanup" patches (ask for them to be split out);
commit messages that state the user-visible effect. Kernel reviewers expect a
concrete call chain or interleaving ("A takes …, B blocks …, A calls …").

**Rust.** Soundness of each `unsafe` block, and whether its safety comment
proves it; buffers lent to the kernel or another thread (ownership must move,
not a `&mut` borrow, for io_uring and DMA); `Drop` running during a panic;
panics in destructors; `Send` and `Sync` bounds; overflow behaviour that
differs between debug and release, or between `fetch_add` (wraps) and plain
arithmetic (panics).

**Go.** Holding a mutex across I/O, channel sends or callbacks; goroutines that
outlive their request or never exit; `context` deadlines passed down; `io.EOF`
versus truncation errors; new exported API (needs an accepted proposal); hot
paths in the runtime and compiler, where reviewers count instructions.

**CPython and C extensions.** Reference counts on every exit path; borrowed
references across calls that can run arbitrary code; free-threading, where a
critical section can be suspended, so use `Py_SETREF`/`Py_XSETREF` and
re-check after re-acquiring; `SystemExit`, `KeyboardInterrupt` and
cancellation must propagate unchanged; deprecations and behaviour changes need
a NEWS entry and a transition.

**Node.js and V8.** Raw pointers or handles to V8 objects across anything that
can trigger GC; untracked GC roots (use `BaseObject` and memory tracking);
running the event loop re-entrantly; realm-safe type checks
(`util.types.isArrayBuffer`, not `instanceof`); Node-API is ABI stable, so
enums only gain values at the end.

**JVM (HotSpot, JDK).** Safepoints invalidate raw oops, so save return values
before calls that can safepoint; pending exceptions must be checked and
cleared; platform ports (RISC-V, s390, PPC) must follow the pattern of the
reference port (x86, AArch64); asynchronous `close()` needs the lock.

**.NET runtime.** Read `Marshal.GetLastPInvokeError()` immediately after the
failing call; callbacks invoked under a lock; collectible versus
non-collectible types in caches.

**Compilers (LLVM, rustc, Swift, Cranelift, JITs).** Every variant of the IR
construct (other opcodes, map IDs, vector scaling such as `vscale`); poison and
undef semantics; memory operands and flags preserved when instructions are
rewritten; instruction-set manuals (reserved encodings, which instructions set
condition codes); compile-time cost of new analyses.

**Databases and storage (DuckDB, etcd, SQLite-like engines).** Transaction
rollback restores every effect, including in-memory catalog changes;
consistency of revision and snapshot numbers (watch from the read revision plus
one); per-entry fsync cost; on-disk format versioning, so that defaults such as
a salt can change later.

**Cryptography and TLS (OpenSSL, Go crypto).** Conformance to the RFC or
protocol document, including reserved and padding fields; sequence counters and
their width on the wire; secrets kept out of copyable strings and logs; minimum
key sizes when generation is pluggable; decisions such as cipher checks made
once rather than re-asked of a callback.

**Kubernetes and control planes.** Upgrade safety: old configuration and
persisted objects must still validate; feature-gate on and off, including
moving between them; validation that makes recovery impossible; work done
under shared cache locks at cluster scale.
