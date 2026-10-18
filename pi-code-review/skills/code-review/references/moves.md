# What top reviewers raise, area by area

Real comments from top reviewers that changed the code, grouped like the
checklist in `SKILL.md`. Read the section for the area you are checking to see
the kind of problem, the level of detail, and how it was put. Every comment is
from a change outside the benchmark set. For more, run
`node scripts/examples.mjs --move <name>`; the move name is given under each
heading.

## Inputs and cases

### A case the code does not handle
`missed_case`

> Above needs to calculate the DUN correctly when the data unit size is less
> than the file logical block size, or else the combination of sub-block data
> units and per-extent encryption needs to be explicitly not supported.

Eric Biggers, [linux-block](https://lore.kernel.org/linux-block/20260221221153.GA2123@quark/)

> E.g., this is true for now but there are two other decoding map IDs, 5 and 6,
> that would trip over this.

abrown, [Wasmtime](https://github.com/bytecodealliance/wasmtime/pull/11153#discussion_r2191175475)

> Think this is incorrectly implemented because you cannot resume watch after
> getting compacted without kicking all the watches opened. You will leave a gap
> in watch history.

serathius, [etcd](https://github.com/etcd-io/etcd/pull/20160#discussion_r2141994933)

> What about the case when you pass an explicit dtype? With this change, the
> following test fails: […]

benburrill, [NumPy](https://github.com/numpy/numpy/pull/29715#discussion_r2334744770)

### Platform assumptions
`platform_assumption`: endianness, alignment, word size, calling conventions,
OS or toolchain.

> But XMM registers are lower halves of corresponding YMM registers! So if YMM
> registers are clobbered you still need to save the non-volatile XMM
> registers.

t8m, [OpenSSL](https://github.com/openssl/openssl/pull/30160)

> This will read too much when targeting a 32-bit process. We'll need some way
> for the caller to specify the pointer size.

mikeash, [Swift](https://github.com/swiftlang/swift/pull/82638#discussion_r2190932519)

> Possibly this is the problem for arm32. It has maxAlign of 8, whereas all
> other platforms have 32.

Keith Randall, [Go](https://go-review.googlesource.com/c/go/+/724261/comment/cbe20db0_30e8d225/)

## Conditions and values

### Wrong condition or value
`wrong_condition_or_value`

> You cannot register watch for storage on `0` revision because any state. You
> need to register it on revision returned by get plus one.

serathius, [etcd](https://github.com/etcd-io/etcd/pull/20372#discussion_r2232054776)

> In other words, this is a directly returned error, not a `-1` and `errno`
> situation.

cuviper, [Rust](https://github.com/rust-lang/rust/pull/141829#discussion_r2141164832),
quoting the man page

## State

### State updated twice, never, or in the wrong place
`state_update_error`

> When do you reset `ua.skipTxnRangeExecution`? The state should be only per
> request rather than global.

ahrtr, [etcd](https://github.com/etcd-io/etcd/pull/21432#discussion_r3252807496)

> `w.s` is a buffered channel. If the pod is allowed/rejected by some plugin,
> WaitOnPermit func consumes that message and then Preempt can enqueue the next
> one and return true (when it should return false).

macsko, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/135719#discussion_r2661255559)

### Work not undone on failure
`partial_failure_consistency`

> This erase is immediate, so rolling back a transaction that drops a
> connection-scoped secret does not restore it.

lnkuiper, [DuckDB](https://github.com/duckdb/duckdb/pull/23527#discussion_r3537364027)

> This drops the key. If the destructor of the key panics, we don't call
> `abort` or adjust `hashes_by_task`.

Darksonn, [Tokio](https://github.com/tokio-rs/tokio/pull/7252#discussion_r2057808417)

## Failure paths

### Cleanup on error paths
`error_path_cleanup`: leaks, double frees and use-after-free on error,
cancellation or shutdown paths, and ownership transfers the cleanup ignores.

> when mapped() returns an error, unmap_vma_locked(vma) is called but execution
> continues into the vm_private_data update below. After unmap_vma_locked() the
> VMA may be freed […], so accessing vma->vm_private_data after that is a
> use-after-free.

Usama Arif, [linux-fsdevel](https://lore.kernel.org/linux-fsdevel/20260313110238.2500603-1-usama.arif@linux.dev/)

> `SSL_set0_rbio` takes ownership here, but `inbio` remains non-NULL. If any
> later assertion fails, cleanup reaches `SSL_free(ssl)` and then
> `BIO_free(inbio)`. I forced the sequence assertion to fail under ASan and got
> a heap-use-after-free.

idrassi, [OpenSSL](https://github.com/openssl/openssl/pull/32064#discussion_r3663113234)
(note the reviewer proved it)

> Dropping the lock here will want to happen as part of a `Drop`-based
> destructor instead of manually here to handle panicking, for example, in the
> constructor.

alexcrichton, [Wasmtime](https://github.com/bytecodealliance/wasmtime/pull/11836#discussion_r2429463051)

### Errors lost or unchecked
`error_lost_or_unchecked`

> The last PInvokeError may be overwritten between this Sysctl and this point.
> For example, `NativeMemory.Free` may overwrite it in some situations. It would
> be better to call `Marshal.GetLastPInvokeError()` right after `if (ret != 0)`.

jkotas, [.NET](https://github.com/dotnet/runtime/pull/119218#discussion_r2312113527)

> If `block_on` returns an `Err` then that means that the fiber needs to exit
> ASAP […], meaning that if this is ignored then wasm might just continue on its
> merry way while the caller expects it to exit ASAP.

alexcrichton, [Wasmtime](https://github.com/bytecodealliance/wasmtime/pull/11895#discussion_r2449637256)

> If err is io.EOF, this should still be errH3FrameError (truncated varint).

Damien Neil, [Go x/net](https://go-review.googlesource.com/c/net/+/792000/comment/77d2cc76_39cc4bcc/)

### Hidden exits
`hidden_control_flow`: exceptions, callbacks and alternate paths the change
misses.

> I think this line has the same bug, and needs to return session credit too.
> It looks reachable if user code destroys the stream in the callback.

pimterry, [Node.js](https://github.com/nodejs/node/pull/65309#discussion_r3864011265)

> Anything that can throw needs to be wrapped in `try/catch` in the C API.

Mytherin, [DuckDB](https://github.com/duckdb/duckdb/pull/18246#discussion_r2212634522)

## Concurrency

### Races
`race_condition`

> The old_valid_size value can be stale as soon the lock is dropped. So the lock
> here is not useful, but unless something else protects the value the code
> might be racy. Also why does this use a sb-wide lock for a per-inode value?

Christoph Hellwig, [linux-fsdevel](https://lore.kernel.org/linux-fsdevel/20260512063416.GA30619@lst.de/)

> This should do Py_SETREF as critical section can be suspended and another
> thread can fill the value.

kumaraditya303, [CPython](https://github.com/python/cpython/pull/154691#discussion_r3710206425)
(free-threaded build)

> Can't have unsynchronized access (i.e. without mutexes or similar
> concurrency control) in global mutable state, declaring this as `static` is
> pretty much a non-starter.

addaleax, [Node.js](https://github.com/nodejs/node/pull/59691#discussion_r2314287591)

> I don't think that this is a valid implementation of the API because if locks
> are acquired in order then this could cause a deadlock by having multiple
> locks get mapped to the same lock.

alexcrichton, [Wasmtime](https://github.com/bytecodealliance/wasmtime/pull/11836#discussion_r2429475893)

### Work done while holding a lock
`blocking_under_lock`

> Please call `notify_waiters()` after releasing the `self.lock` mutex.

Darksonn, [Tokio](https://github.com/tokio-rs/tokio/pull/7418#discussion_r2189100724)

> Callbacks executed under a lock are a potential dead lock factory if the
> callback does anything non-trivial.

jkotas, [.NET](https://github.com/dotnet/runtime/pull/116075#discussion_r2190405276)

> For most file systems we try to have the generic_write_sync outside the inode
> lock to not do the expensive sync with the inode locked.

Christoph Hellwig, [linux-fsdevel](https://lore.kernel.org/linux-fsdevel/aq1UW699LW2pxvHU@infradead.org/)

A full worked scenario, by Matthew Wilcox on
[linux-mm](https://lore.kernel.org/linux-mm/anbZpzFbtYG7Ngit@casper.infradead.org/):

> A takes mmap_read_lock / B tries to take mmap_write_lock, blocks / A calls
> copy_from_user() / […] / A tries to take the mmap_read_lock again to make
> sure. Deadlock because B is waiting for A to release the mmap_read_lock. Am I
> missing something?

### Ordering and stale data
`ordering_staleness`

> This seems like it needs release semantics -- otherwise another thread could
> read a table index and only see some of the previous writes, thereby getting a
> half-valid or torn record.

Achierius, [WebKit](https://github.com/WebKit/WebKit/pull/50091#discussion_r2409007485)

> Please set the value first, and then write to the atomic. Also, using `store`
> is sufficient. With the mutex, we no longer need `swap`.

Darksonn, [Tokio](https://github.com/tokio-rs/tokio/pull/7418#discussion_r2184681184)

## Lifetime and memory

### Lifetime and ownership
`lifetime_ownership`

> Passing raw pointers to V8 objects in the API is unsafe because of GC (even if
> you disallow GC inside the method, the GC can still happen in a race after the
> point you get the pointer and before the API call, and make that pointer
> dangling).

joyeecheung, [Node.js](https://github.com/nodejs/node/pull/62491#discussion_r3005998148)

> `token_buf_.data.ptr` here points into the inline `token_data_` member array
> which is set in the constructor. The class declares no copy or move members.
> […] storing or returning it by value would corrupt the worker heap. I think you
> can `= delete` the copy and move members.

agrawroh, [Envoy](https://github.com/envoyproxy/envoy/pull/45641#discussion_r3487337303)

> You must transfer ownership of the buffer to the `Read` operation. Passing a
> `&mut Vec<u8>` is not enough.

Darksonn, [Tokio](https://github.com/tokio-rs/tokio/pull/7696#discussion_r2443244594)
(io_uring: the kernel may still write after the future is dropped)

> `get_jvmti_thread_state()` can safepoint […]: if there is a return oop at the
> top of the stack, it could become invalid if a GC occurs.

pchilano, [OpenJDK](https://github.com/openjdk/jdk/pull/26713#discussion_r2274899453)

### Overflow and bounds
`arithmetic_bounds`

> This correctly copies only the six-byte DTLS sequence, but the write path
> still calls `tls_increment_sequence_ctr`, which increments all eight bytes. I
> tried starting the new test at `fffffffffffd`: […] the carry is hidden and the
> client will discard the wrapped records.

idrassi, [OpenSSL](https://github.com/openssl/openssl/pull/32064#discussion_r3666421965)

> index is scaled by vscale so this permits out-of-bounds extracts.

c-rhodes, [LLVM](https://github.com/llvm/llvm-project/pull/198012#discussion_r3260567568)

## Behaviour preservation

### A rewrite that changes behaviour
`not_behaviour_preserving`

> This isn't a functionally equivalent transformation, and it's purposefully
> not returning failure to increase. It may still succeed if we fail here,
> relying on failure later for the actual operation.

Jens Axboe, [io-uring](https://lore.kernel.org/io-uring/2f6be7db-5764-8a48-ccbd-4a49f522eae2@kernel.dk/)

> I think this will change behavior in non-debug builds such that repeated
> `blocktxn` messages will now be ignored (whereas they would result in
> `READ_STATUS_INVALID` / disconnection before).

mzumsande, [Bitcoin Core](https://github.com/bitcoin/bitcoin/pull/33296#discussion_r2323690854)

## Contracts

### Breaking existing users
`compat_break`

> By inserting a new enum value in the middle of the existing enum values we
> effectively change integer values for all enum values that follow the
> inserted entry. Any previously compiled code […]

vmoroz, [Node.js](https://github.com/nodejs/node/pull/58879#discussion_r2173842424)
(Node-API is ABI stable)

> Adding new CAPI functions to an old version is not allowed. It would break
> backwards compatibility.

samansmink, [DuckDB](https://github.com/duckdb/duckdb/pull/18215#discussion_r2199996928)

> This changes the semantic of failure_mode_allow, as it now includes ext_proc
> server response path. Should we introduce a new config […] rather than
> overloading the existing field?

tyxia, [Envoy](https://github.com/envoyproxy/envoy/pull/39994#discussion_r2164872649)

### Disagreeing with the specification
`spec_contract_mismatch`. Reviewers read the spec and cite it.

> according to PROTOCOL.mux the padding must be `0`. Please add a check.

Nicola Murino, [Go x/crypto](https://go-review.googlesource.com/c/crypto/+/733040/comment/2324a668_87edaddb/)

> The manual says `00000` is reserved for the `m-mmmm` field and would result in
> a `#UD`.

abrown, [Wasmtime](https://github.com/bytecodealliance/wasmtime/pull/10754#discussion_r2082096825)

> This is wrong! It never requires blocking on the `JoinHandle`. As long as
> `Runtime::block_on()` is called *with any future*, spawned tasks will execute.

Darksonn, [Tokio](https://github.com/tokio-rs/tokio/pull/7803#discussion_r2656513774)
(documentation that misstates the contract)

### Misusing an existing API
`api_misuse`. Read the callee before trusting its name.

> io_uring_register_get_file() accesses task private data and the request
> doesn't control from which task it's executed. IOW, you can't use the helper
> here.

Pavel Begunkov, [linux-block](https://lore.kernel.org/linux-block/0c542e65-d203-4a3e-b9fd-aa090c144afd@gmail.com/)

> During stream capture, your events are considered to be representing empty
> sets of work […], so cudaEventQuery will always return cudaSuccess.

galv, [PyTorch](https://github.com/pytorch/pytorch/pull/158352#discussion_r2212340787)

> This is unfortunately wrong as msr does not set CC. You'll have to use msrkc.

uweigand, [Wasmtime](https://github.com/bytecodealliance/wasmtime/pull/12523#discussion_r2770345750)

### Gates, rollout and defaults
`rollout_gating`

> We should allow moving from recreate ALWAYS, no matter what the FG value is.

soltysh, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/137187#discussion_r3519850591)

> It is not safe to rollout all the behavior changes in one shot for a massive
> existing traffic deployment.

botengyao, [Envoy](https://github.com/envoyproxy/envoy/pull/43927)

## Cost

### New per-item cost
`hot_path_cost`

> This will now do a `pipeline_flush_mut` call per segment rather than once at
> the end. And this function can be relatively expensive when you have a cpu
> with many cores as it needs to send an ipi to every cpu core.

bjorn3, [Wasmtime](https://github.com/bytecodealliance/wasmtime/pull/10512#discussion_r2031799026)

> I'm worried about overhead of forcing sync for every entry just to fix
> `--force-new-cluster`.

serathius, [etcd](https://github.com/etcd-io/etcd/pull/20055#discussion_r2116138281)

> If the performance regression is not acceptable, it is an option to have two
> caches - one for collectible types and one for non-collectible types.

jkotas, [.NET](https://github.com/dotnet/runtime/pull/114619)

## Security

### Trust boundaries and secrets
`security_boundary`

> Given we are going through lengths here not to page out the memory of the
> encryption key - I think we should not use a `std::string` to store the
> encryption key. It is very easy to accidentally copy over an `std::string`.

Mytherin, [DuckDB](https://github.com/duckdb/duckdb/pull/17275#discussion_r2070177171)

> that's not a secure bit size ... making this pluggable allows for injecting
> insecurely-weak key generation ... should we require minimum bit sizes?

liggitt, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/138999#discussion_r3422365805)

> Can we add a validation rule to disallow semicolons and control chars in the
> path? This would prevent both intentional and accidental header injection.

zhaohuabing, [Envoy](https://github.com/envoyproxy/envoy/pull/41929#discussion_r2591086165)

## Design

Design comments are common, and authors reject them more often than almost
any other kind. Raise one when you can name the alternative and what it buys.

### An existing mechanism
`reuse_existing`

> define a stack-allocated `fixed_strides` array that's explicitly initialized
> up to `nout`. Look at `try_reduce_contiguous` for an example that does this
> correctly.

ngoldbaum, [NumPy](https://github.com/numpy/numpy/pull/31816#discussion_r3625223444)

> I think we should use the `isArrayBuffer` function from
> `internal/util/types`. […] It recognizes ArrayBuffers from a different realm.

legendecas, [Node.js](https://github.com/nodejs/node/pull/57828#discussion_r2039486169)

### The wrong layer
`wrong_place`

> Rather than use a mutable setter pattern with action-at-a-distance plumbing,
> let's compute the property directly from the ABI code.

cfallin, [Wasmtime](https://github.com/bytecodealliance/wasmtime/pull/11581#discussion_r2314592859)

> This should only be exposed for a usb::Interface<Bound>, i.e. note the Bound
> device context.

Danilo Krummrich, [rust-for-linux](https://lore.kernel.org/rust-for-linux/DJBGCJZ3CMEX.3ORMLBEQE87LS@kernel.org/)

### A simpler approach
`simpler_design`

> it seems really odd to not let someone change their statefulset rollout
> strategy ... why are we making them delete their statefulset for this? won't
> that cause data loss?

liggitt, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/137187#discussion_r3597597029)

> One thing that we could consider here that might help is to just never
> consider two named `TypedDict` types as redundant in a union, unless they are
> the exact same type.

carljm, [Ruff](https://github.com/astral-sh/ruff/pull/21467)

## Tests

Ask for the specific case and say what it would catch. Generic requests for
more tests are a common reason authors reject AI review comments.

> This test would be more interesting if it sends BLOCK_CAP messages before
> closing. This will test the edge case where `block_tail` advances to a new
> block during `close()`.

martin-g, [Tokio](https://github.com/tokio-rs/tokio/pull/8062#discussion_r3104493557).
The author replied: "Good call. I don't actually think the code was right as-is!"

> Could you also test it with the named types `error` and `unsafe.Pointer`?
> These two edge cases (error has no package, and unsafe.Pointer has no Pos) are
> a frequent source of crashes and other bugs.

Alan Donovan, [Go tools](https://go-review.googlesource.com/c/tools/+/689196/comment/9b5bf725_3f0fc6f6/)

> use Type=notify and NotifyAccess=all and call systemd-notify --ready before
> sleeping, instead of looping which is racy and will fail on slow systems.

bluca, [systemd](https://github.com/systemd/systemd/pull/37838#discussion_r2159662834)
(test_quality)

## Explanation

### Hidden contracts
`explain_document`: ask for the invariant to be written down.

> `batch_index` has a hidden contract here: it must be unique, gapless, and
> start at 0. A duplicate is silently discarded by `emplace`, while a gap leaves
> later jobs pending forever. The native table scan currently starts its batch
> index at 1, is that a problem?

lnkuiper, [DuckDB](https://github.com/duckdb/duckdb/pull/24778#discussion_r3805058795)
