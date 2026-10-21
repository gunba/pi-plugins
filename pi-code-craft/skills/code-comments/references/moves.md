# What maintainers raise about code comments

Real review remarks from maintainers of top projects that changed the comments
they were about, grouped like the checks in `SKILL.md`. For more, run
`node scripts/examples.mjs --move <name>`; the name is under each heading.

## Comments that are wrong

### A comment the code no longer matches, or never did
`wrong_or_stale`

> Technically I don't believe this is correct, and also technically the tests in this PR violate this by having a different host function return the u64 "pointer" which gets read/mutated. I think this'll want to be reworded, or perhaps even dropped entirely? Whether or not a modification/read of memory is safe is more-or-less up to Miri in a sense so we could somewhat defer to that.

alexcrichton, [Wasmtime](https://github.com/bytecodealliance/wasmtime/pull/11825#discussion_r2418017366)

> This is wrong!
> It never requires blocking on the `JoinHandle`.
> As long as `Runtime::block_on()` is called *with any future*, spawned tasks will execute. The `JoinHandle` does not matter. You could even call `rt.block_on(pending())` in a background thread.

Darksonn, [Tokio](https://github.com/tokio-rs/tokio/pull/7803#discussion_r2656513774)

> This comment is wrong.  The reason GC allocations set update_watermark is to force updating of the memory that is allocated by the GC following the start of evacuation.  Mutator allocations do not adjust update watermark with each new allocation because initialization and writes to newly allocated Mutator memory already honor the "to-space invariant".

kdnilsen, [OpenJDK](https://github.com/openjdk/jdk/pull/31314#discussion_r3399130803)

> M' in the standard refers to the encoded message i.e. 0X || ctx_len || ctx || msg. 
> The value passed in when msg_is_mu is 1 is actually a precomputed mu.
> i.e. H(Bytestobits(tr)||M`)

slontis, [OpenSSL](https://github.com/openssl/openssl/pull/27322#discussion_r2038362324)

> This is a misleading comment. Even if multiple threads were at play, accessing the dictionary would still be atomic.

ZeroIntensity, [CPython](https://github.com/python/cpython/pull/144604#discussion_r2787975509)

### Wording that misleads
`unclear`

> Can you clarify in the comment which frames this might include?  Is it "this frame and/or its descendant frames ... [excluding those] that don't have beforeunload handlers defined" like beforeunload_pending_replies_?  I guess it's slightly trickier since this is on NavigationRequest instead of RFH, but maybe it still applies to the navigating frame and its descendants?
> Hopefully we're careful about not leaving any dangling pointers in here if descendant frames are removed?

Charlie Reis, [Chromium](https://chromium-review.googlesource.com/c/chromium/src/+/7413835/comment/989fffe0_a3211816/)

> don't the select and channel ops also have to be blocked on another goroutine in the bubble too? this seems to say that merely being in the middle of a (possibly runnable) channel receive is sufficient to durably block.

Jason Aten, [Go](https://go-review.googlesource.com/c/go/+/671961/comment/7bd42ce5_b3ec6998/)

> Hm, I think we should revisit this wording before we stabilize to avoid "implementation-defined" here -- that to me implies that e.g. rustc behaves consistently (at least on a single target), but as this clarifies the context of the intrinsic's use matters - and even a single invocation of the intrinsic can be compiled to multiple actual instructions with different choices I imagine (e.g., a valid implementation is `if random() { choice a } else { choice b }` I'd guess).

Mark-Simulacrum, [Rust](https://github.com/rust-lang/rust/pull/151793#discussion_r3608748470)

> The documentation is a bit unclear that the stride will not match if the memory_format is specified. What if I want channels_last, channels_first memory format with a specific stride? 
> I guess I don't know if the invariant that non preserve memory format always implies standard striding is true.

Skylion007, [PyTorch](https://github.com/pytorch/pytorch/pull/158188#discussion_r2202752441)

## What is missing

### An unwritten contract or invariant
`document_contract`

> This hands back a `*mut` from a `&self`, and the example mutates through it. The pointer is shared, since a second filter or the rebuilt filter can hold it too.
> Could you also document that the module must synchronize any interior mutability and that the pointer is valid only on the owning worker thread?

agrawroh, [Envoy](https://github.com/envoyproxy/envoy/pull/45888#discussion_r3509941850)

> As far as I can tell, this relies on "keep" being protected against parallel deletes of series with the checkpoint. Otherwise we might drop a tombstone , but not the series. Worth a mention in the docstring of the Checkpoint function for future us or more likely LLMs.

krajorama, [Prometheus](https://github.com/prometheus/prometheus/pull/19140#discussion_r3549483860)

> It's not really about DMA allocations that have been made previously, there is
> no unsafe behavior in that.
> It's about the method must not be called concurrently with any DMA allocation or
> mapping primitives.
> Can you please adjust the comment correspondingly?

Danilo Krummrich, [rust-for-linux](https://lore.kernel.org/rust-for-linux/7fb081e9-e607-401b-937f-f4e3a78a2874@kernel.org/)

> It seems like the `DependencyManager` would deadlock if `ClusterSubscription` is called in a blocking manner while handling an xDS configuration update in a watcher. I don't think such a use case exists in gRPC presently, so it may be fine not to handle it. However, the godoc should mention this limitation in case things change in the future. Similar for the `Unsubscribe` method.

arjan-bal, [gRPC-Go](https://github.com/grpc/grpc-go/pull/8792#discussion_r2660352415)

> We should mention here that ownership is passed (i.e the caller shouldn't have to call `release()` on it anymore, `release` is nullptr)

Tishj, [DuckDB](https://github.com/duckdb/duckdb/pull/18246#discussion_r2205194629)

### Incomplete interface documentation
`api_docs`

> It should not be inheritable, because other process may inherit it by accident before we get here.
> Also, do mention File.OpenNullHandle and Console.OpenSatndardInputHandle API

adamsitnik, [.NET runtime](https://github.com/dotnet/runtime/pull/125848#discussion_r2968365640)

> At least here we should probably repeat the warning against `OSSL_FN_mod_exp_mont` which says "This path is not constant-time per se; do not use it for secret exponents."

mattcaswell, [OpenSSL](https://github.com/openssl/openssl/pull/31962#discussion_r3675866797)

> I am OK to ignore the `stat_prefix` in the per route configuration but please document it clearly at the API comments. And I think you may need to check your implementation here. When the `stat_prefix` is set at per route configuration, seems you will still generate the stats object?

wbpcode, [Envoy](https://github.com/envoyproxy/envoy/pull/41236#discussion_r2404545791)

> Missing doc comments on the type and both fields.
> Also — does this need to be exported? The only producer is `ExportRewindSnapshot` and the only consumer is `ApplyRewindSnapshot`, both right here. Exporting the fields lets a future caller build one with bogus values that bypass the manager's invariants. Could keep `RewindSnapshot` exported as an opaque round-trip token but unexport `markers`/`acqLen`.

rafiss, [CockroachDB](https://github.com/cockroachdb/cockroach/pull/169166#discussion_r3162154223)

### A reason that is not written down
`explain_why`

> Can you add a comment here saying something like: there is no utf8 validation in stremaing no buffering case (i.e. utf8_range::IsStructurallyValid) due the stateless nature of streaming  (i.e., stateful UTF-8 validator that tracks validation state across chunk) etc.
> If the upstream sends invalid UTF-8, it will be streamed as-is to the client, which might fail to parse the JSON

tyxia, [Envoy](https://github.com/envoyproxy/envoy/pull/45076#discussion_r3307109972)

> It might be worth a comment here to address a concern a reader (e.g., me!) might have, that a "bitfield move" does some sort of field insertion and keeps the other original bits in `rd` (which would require a "modify" effect built of a use and a reuse-def instead). I looked it up and AArch64 is carefully spec'd here to avoid that dependency-creating issue by *zeroing* the other bits in rd; so this is a true def only (the code is correct). Just wanted to ensure we document that!

cfallin, [Wasmtime](https://github.com/bytecodealliance/wasmtime/pull/14187#discussion_r3846877274)

> nit: similarly, I think the cache control here is non-trivial and would benefit from documentation. My understanding is: the endpoint is txid based, so unconfirmed transactions can easily be replaced (e.g. RBF) and should be considered ephemeral. For confirmed transactions: the block in which they're confirmed can be re-orged out, re-introducing the replacement concern. Also, the response commits to the blockhash in which it's confirmed.
>  (+ 2 other paths below)

stickies-v, [Bitcoin Core](https://github.com/bitcoin/bitcoin/pull/34794#discussion_r3288083782)

> Maybe also mention `RLIMIT_NOFILE` ?! 
> Trying to set a bigger value will lead to a failure.

martin-g, [Tokio](https://github.com/tokio-rs/tokio/pull/7978#discussion_r2967962217)

### A missing source
`reference`

> Keeping this list updates is not going to be easy. So we should avoid listing all the experimental metrics and instead add a couple of metrics with a  comment on top stating that these are experimental metrics and link to the list of [all possible metric values](https://grpc.io/docs/guides/opentelemetry-metrics/#instruments).

arjan-bal, [gRPC-Go](https://github.com/grpc/grpc-go/pull/8388#discussion_r2149041959)

> I like the idea of documenting this so it's easier to understand.
> There is risk of drift from the actual implementation. You may want
> to add a comment to the method in commit-reach.c to indicate that
> any change should be reflected in this document.

Derrick Stolee, [git](https://lore.kernel.org/git/50dd5fb1-6b4e-448c-977c-cdc476f7fe40@gmail.com/)

> Leave a very brief comment mentioning the test in snapshotfs_test.go here and on the other remaining nil check.

andrewbranch, [typescript-go](https://github.com/microsoft/typescript-go/pull/2814#discussion_r2823256942)

## What should go

### A comment that repeats the code
`redundant`

> This comment is incorrect, as this is 32-bit arm and a uint32 would be fine to align the uintptr.
> I'm not sure the comment helps much anywhere else. All that matters is that the struct matches what the kernel expects. We don't need a comment that essentially says "this matches what the kernel expects." Thanks.

Ian Lance Taylor, [Go](https://go-review.googlesource.com/c/go/+/819660/comment/634fd1ab_3584e99e/)

> I think (1) is redundant :drum: with (2), and you can simplify the whole thing to "`C | D` is gradually equivalent to `D`, and `C & D` is gradually equivalent to `C`". That even nicely maps with the intuitive English definition. (You might still keep (1) as a separate check in the implementation, as an optimization, but that's not needed here in the theoretical definition)

dcreager, [Ruff](https://github.com/astral-sh/ruff/pull/20602#discussion_r2392024650)

> This comment is not very useful, because it just describes the code below.
> Suggestion: "If the value appears to be before `insertionPoint` cloning is not necessary, because we can just reuse the value. Note that if the value is in a different block it _must_ come before `insertionPoint` because `value` dominates `insertionPoint`".
> Also, I would replace `!inst` with `isa<SILArgument>(value)` to make the intention clear.

eeckstein, [Swift](https://github.com/swiftlang/swift/pull/87819#discussion_r2945628337)

### A comment about the change, not the code
`change_narrative`

> In commit "mining: fix -blockreservedweight shadows IPC option" (336826ad0e70978783dcc0777ad1f01d3dbc1698)
> Would suggest deleting this comment because it's confusing to reference past behavior here. Instead I think it would be better to expand the "Set an absurd reserved weight" comment above. It can say the test confirms that the `-blockreservedweight` value is ignored by sending a transaction that would not fit with in a template with a huge reserved weight, and confirming the transaction does appear.

ryanofsky, [Bitcoin Core](https://github.com/bitcoin/bitcoin/pull/33965#discussion_r2669916481)

> @Tiaonmmn Once this PR is merged, the comment on l. 26-30 will only have archeological value - since NEON isn't disabled anymore, it makes no sense to discuss why it's not disabled anymore. Please remove the comment.

rschu1ze, [ClickHouse](https://github.com/ClickHouse/ClickHouse/pull/107440#discussion_r3751424850)

### More than the reader needs
`too_long`

> How about something like:
> // We keep the failed partialBlock to disallow processing another compact block announcement from the same
> // peer for the same block. We let the full block download below continue under the same m_downloading_since timer.

instagibbs, [Bitcoin Core](https://github.com/bitcoin/bitcoin/pull/33296#discussion_r2325239854)

> Comment here hyw does pyiceberg runs, i.e. why not inside docker
> And also no need to explain it that verbose, it is enough to tell that it runs from the host

azat, [ClickHouse](https://github.com/ClickHouse/ClickHouse/pull/102861#discussion_r3237114280)

> I think the example here could be simplified to something a bit less specific. E.g. 
> > For example, a library may use the creation and consumption of ZST tokens as a way to express scopes. Using `conjure_zst` to forge these tokens rather than going through the proper interfaces could cause unsoundness.
> (could also be smooshed into the previous paragraph)

tgross35, [Rust](https://github.com/rust-lang/rust/pull/146479#discussion_r2397108041)

### Code that should say it instead
`code_instead`

> s/allow/expect/
> (that way you're forced to delete this once it's used)

alexcrichton, [Wasmtime](https://github.com/bytecodealliance/wasmtime/pull/11020#discussion_r2142998952)

> In commit "f: libmultiprocess tidy errors" (5be60409931f572d6b094a351e993f646caee02e)
> Can this be changed to `(void)client_connection.release();` to see if it fixes the tidy error? `(void)` should be a more typical way of indicating the return value is intentionally not used

ryanofsky, [Bitcoin Core](https://github.com/bitcoin/bitcoin/pull/34662#discussion_r2848541443)

### Commented-out code
`commented_out_code`

> If you want to leave this placeholder, it should also have a comment explaining the commented code (the new spec isn't out yet!).

Robert Findley, [Go tools](https://go-review.googlesource.com/c/tools/+/679595/comment/8fa073d0_e204096d/)

> Perhaps delete the `#if 0` branch in Curl_pgrs_now(), or add a comment
> why we want to keep it?

vszakats, [curl](https://github.com/curl/curl/pull/22292)

### TODOs
`todo`

> As discussed, add TODO.
> Note that with a close function being returned, it would have been more obvious that it wasn't getting called.

dfawley, [gRPC-Go](https://github.com/grpc/grpc-go/pull/8745#discussion_r2628936663)

> In `DisableForbiddenSpanAssertionsOnBatch` definition, pop in a TODO to eliminate all its users?

pav-kv, [CockroachDB](https://github.com/cockroachdb/cockroach/pull/157153#discussion_r2547077877)

> please add a TODO here - this should be temporary.
> There is an update going on on the resolveArmResources side that a new property will be added to include this information.

ArcturusZhang, [azure-sdk-for-net](https://github.com/Azure/azure-sdk-for-net/pull/54643#discussion_r2638834504)

## Form

### In the wrong place
`placement`

> The regexp formerly had documentation; now its doc comment has slipped onto the findDocLinkIndices function. Please retain the documentation of the regexp (old and new), briefly explaining why we need two passes, and give the function its own doc comment that describes its abstraction, not its implementation.
> But why does this require two passes? The old regexp had a suffix that matched a non-colon or EOL. Why did that not suffice?

Alan Donovan, [Go tools](https://go-review.googlesource.com/c/tools/+/715240/comment/1827700d_41c331bb/)

> Is this in the right place? This is the generic Engine API documentation and this feature only works for Django templates and not Jinja2 templates, right?

ngnpope, [Django](https://github.com/django/django/pull/19643#discussion_r2246299807)

> Note that there is no struct case above. So our ABI compatibility rules never consider a (non-transparent) struct ABI compatible with any other type.
> *[View changes since the review](https://triagebot.infra.rust-lang.org/gh-changes-since/rust-lang/rust/155361/e8e4541ff19649d95afab52fdde2c2eaa6829965..1fd013eecee54c85585049c31358841b6517c498)*

RalfJung, [Rust](https://github.com/rust-lang/rust/pull/155361#discussion_r3091043780)

### The project's comment format
`format_convention`

> I think we are establishing a pattern where DV tags on gated fields are ALL prefixed with `ifEnabled` so this should be `+k8s:ifEnabled(TopologyAwareWorkloadScheduling)=+k8s:immutable`

thockin, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/137271#discussion_r2941678017)

> Can use `DEPRECATE` macro, also should include the deprecating NumPy version in the message and as a comment above, like `/* DEPRECATED NumPy ..., 2025-... */`

seberg, [NumPy](https://github.com/numpy/numpy/pull/29052#discussion_r2120516506)

> Please follow example below to add deprecated,
> https://github.com/etcd-io/etcd/blob/effaa795086bd7a09203447fc55e3821e93f7181/server/embed/config.go#L406C5-L406C15

ahrtr, [etcd](https://github.com/etcd-io/etcd/pull/19913#discussion_r2231551510)
