# What maintainers raise about tests

Real review remarks from maintainers of top projects that changed the tests
they were about, grouped like the steps in `SKILL.md`. Read the section for
the step you are on to see the kind of problem and the level of detail
reviewers expect. All come from changes outside the benchmark set. For more,
run `node scripts/examples.mjs --move <name>`; the name is under each heading.

## Cases

### A case the tests do not cover
`missing_case`

> Please add an integration test for this code combined with the `on_demand` cert selector; I want to ensure that the invariant of one cert chain per SSL_CTX holds. 
> @kyessenov and concerns with how this interacts with `on_demand`?
> /wait

ggreenway, [Envoy](https://github.com/envoyproxy/envoy/pull/45645)

> mailto? file?  others?   I think only test that works is the one described at https://www.rfc-editor.org/rfc/rfc3986#page-17

richsalz, [OpenSSL](https://github.com/openssl/openssl/pull/27448#discussion_r2051806912)

> This test would be more interesting if it sends [BLOCK_CAP](https://github.com/tokio-rs/tokio/blob/b010b5ddafb316e5d540de1736f5f7bfde42ec39/tokio/src/sync/mpsc/mod.rs#L146) messages before closing. This will test the edge case where `block_tail` advances to a new block during `close()`.

martin-g, [Tokio](https://github.com/tokio-rs/tokio/pull/8062#discussion_r3104493557)

> It would probably be a good idea to write a test that ensures unread messages can still be read when this happens.  I.e.:
> - Start stream; client sits idle for now
> - Server sends a few messages and a status
> - After the server has done this and we know the client has finished calling `closeStream` (somehow...maybe the server closes the connection (gracefully?) and we check the connectivity state?), client then reads the messages out of the stream.

dfawley, [gRPC-Go](https://github.com/grpc/grpc-go/pull/8832)

### No test for the change
`needs_test`

> WDYT about adding a test that triggers this case? (get oldm set on some P, exit the thread, then do a bunch of scheduling to try and trigger a bad access)

Michael Knyszek, [Go](https://go-review.googlesource.com/c/go/+/714801/comment/b5cc44e1_35190cd7/)

> From a pure configuration perspective, this seems a fairly straightforward. 
> My concern is the impact on wheels (and, for that matter, the binaries in the standard library). iOS wheels are linked against libpython because `-undefined` is flagged as a deprecated linker argument. 
> What (if any) testing have you done of this code with the standard library and/or third party libraries?

freakboy3742, [CPython](https://github.com/python/cpython/pull/156110)

> Do we have tests that exercise this part of the code? Dropping a callback without running it closes the mojo pipe with an error.

Giovanni Ortuno Urquidi, [Chromium](https://chromium-review.googlesource.com/c/chromium/src/+/7549006/comment/ee23855e_06472a0e/)

## Assertions and expectations

### An assertion that is too loose
`weak_assertion`

> Could we check the actual reason here?
> `ERR_GET_REASON(ERR_peek_last_error()) == SSL_R_SEQUENCE_CTR_WRAPPED`
> As written, any unrelated `SSL_ERROR_SSL` would satisfy the test. Using `ffffffffffff` as the starting sequence would also trigger the wrap on the first record instead of depending on the size of the server flight.

idrassi, [OpenSSL](https://github.com/openssl/openssl/pull/32064#discussion_r3687706172)

> Do you wanna check its the host netns? Something like `readlink /proc/self/ns/net` and then compare it to the same outside the container (so just where this test is running)?
> Maybe we should check both that the userns exists and is the expected size and the netns is the one from the host. If we have bash, then the command here can just be `"bash", "-c", "cat ...; readlink ..."`

rata, [containerd](https://github.com/containerd/containerd/pull/12518#discussion_r2860010752)

> What is the purpose of this method? Is it to ensure `RedefFoo` gets recorded in TrainingData? How is this test checking that the references to `RedefFoo` are cleaned up after it is redefined?

ashu-mehra, [OpenJDK](https://github.com/openjdk/jdk/pull/30517#discussion_r3018384392)

### A wrong expected value
`wrong_expectation`

> I get `"optimal": false` immediately after invoking prioritisetransaction, fwiw. (Expected as there is no immediate call to DoWork in that path) Is this assumption really valid?

ajtowns, [Bitcoin Core](https://github.com/bitcoin/bitcoin/pull/34615#discussion_r2831854742)

> Am I correct that we keep tracking the Pod SchedulingThroughput here? Is it how we want to do that (assess how many pods eventually got scheduled per second) or do we plan to switch to the new metric we added?
> If we stick to SchedulingThroughput, are we sure it correctly collects the metic in case we run TAS scheduling simulations (schedule each pod several times)?

dom4ha, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/138341#discussion_r3201332257)

> If we do the above, now we would assume the observations in the zero bucket to be -0.001/2, and the `sum` should be -3.5357839059327376 (i.e. -0.001/2*.5).

beorn7, [Prometheus](https://github.com/prometheus/prometheus/pull/17904#discussion_r2759962080)

### A test pinned to incidental details
`overspecified`

> This test doesn't align with the actual change. In the actual change, only `nsdelegate` and `memory_recursiveprot` are specifically preserved. Other mount options can be lost or added. For example, if the node originally didn't have `nosuid` for some reason, that would be added.

samuelkarp, [containerd](https://github.com/containerd/containerd/pull/12952#discussion_r2886934931)

> The do not run tests are extremely brittle because the query names aren't part of  Salsa's API (they could change any day). It's also very easy to refactor the code so that the query never runs, making the test useless. If you think it's worth testing that the query doesn't run, I think the test should:
> * First test that the query runs (with the same name) when making a similar change
> * Only then test, that the query does not run 
> This is still not a 100% guarantee, but already better.

MichaReiser, [Ruff](https://github.com/astral-sh/ruff/pull/28202#discussion_r4063107875)

> The metadata numbering might not remain the same across the optimization, I think? - so might be worth matching the !dbg metadata number, then matching the definition of that metadata node/its contents.

dwblaikie, [LLVM](https://github.com/llvm/llvm-project/pull/140164#discussion_r2093692099)

## Does it test the change?

### A test that passes without the change
`not_discriminating`

> Oh. So we cannot verify immediately before clone because we can heal and obscure what clone barrier wanted to do, and cannot verify immediately after because we can heal and obscure what clone barrier has missed to do.
> Let's do verification completely out-of-phase then? E.g. clone at random index, verify at another random index? And then also verify everything at very end.

shipilev, [OpenJDK](https://github.com/openjdk/jdk/pull/31001#discussion_r3168738653)

> Actually, since we are using the single thread runtime and there is no yield point here, the `set.try_join_next()` is always `None`, we should rewrite this test.

ADD-SP, [Tokio](https://github.com/tokio-rs/tokio/pull/7609#discussion_r2382493461)

> most of these are fixed points under byteswap so wouldn't detect a bug.  i think 4660, 3735928559, 81985529216486895 will be non-invariant

jbrockmendel, [pandas](https://github.com/pandas-dev/pandas/pull/66972#discussion_r3866999445)

> In fac12f7cf9ebc0b906bbb20ae126cf7e7552fdbb _test: fix interface_ipc.py template destruction_:
> I think the original intention here was to demonstrate that `generate` interrupts an ongoing `waitNext()`.
> Now it only shows that `waitNext()` returns immediately if the tip has changes before calling. Though perhaps it always did that by accident.

Sjors, [Bitcoin Core](https://github.com/bitcoin/bitcoin/pull/34003#discussion_r2598844209)

### A state that cannot happen
`unrealistic_setup`

> Can you change this to `init.scope`? I know we use `task` internally but for upstream we want to use `init.scope` since systemd expects to run within `init.scope` and has a specific check for that so that it doesn't consider its cgroup the root cgroup.

daandemeyer, [systemd](https://github.com/systemd/systemd/pull/37285#discussion_r2087287854)

> Use `AnonymousPipeServerStream` ctor and create a pipe server that creates inheritable pipes in all cases, as `SafeFileHandle.CreateAnonymousPipe` creates non-inheritable pipes and it's impossible to test some scenarios with it.

adamsitnik, [.NET runtime](https://github.com/dotnet/runtime/pull/126318#discussion_r3010773834)

> Just a comment, I think it is kind of fine to do the reorgs through invalidateblock instead of connecting and disconnecting nodes from each other, but the disconnectpool behaviour here is kind of on the line where I would tend to prefer exercising the actual code through `ActiveBestChainStep`, since the two methods do not share the same object. I think to test the mempool in general it is fine to do, both methods at least use the same object at runtime.

sedited, [Bitcoin Core](https://github.com/bitcoin/bitcoin/pull/32516#discussion_r2108930724)

## Reliability

### A result that varies between runs
`flaky`

> Regarding the C++20 memory ordering, the `SeqCst` doesn't guarantee to observe the latest value. Since this test is using the multi_thread runtime, will this be a flaky test?
> Is `fetch_add(0)` a better choice?

ADD-SP, [Tokio](https://github.com/tokio-rs/tokio/pull/7417#discussion_r2173435407)

> Technically it's waiting for the victim to be scheduled, not the preemptor.
> This also leaves room for breaking this test in a flaky way, e.g. the scheduling logic may for some reason schedule the victim first, and the test may not see the preemptor as scheduled yet, as it didn't wait for it.
> Have you considered waiting for both the victim and the preemptor to be scheduled?

brejman, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/135719#discussion_r2657664636)

> Can you mark this test as thread-unsafe? The tracemalloc Python API isn’t thread-safe.

ngoldbaum, [NumPy](https://github.com/numpy/numpy/pull/30902#discussion_r2867002297)

> I think this will be race-y, we should
> 1. keep a ref on the original ready promise (the one we await L34)
> 2. add an error event listener (something like `errorFired = new Promise(resolve => unloading.addEventListener("error", resolve, { once: true }));`)
> and after the `.remove()`
> 1. await the errorFired
> 2. make sure there's a new ready promise `!=` from the original one

etiennesegonzac, [WebKit](https://github.com/WebKit/WebKit/pull/70592#discussion_r3691350715)

### An assumption about the machine
`environment_assumption`

> Deleting the file is going to succeed on Linux. Only on Windows it is going to fail when the handle is still kept open.

cincuranet, [efcore](https://github.com/dotnet/efcore/pull/36176#discussion_r2123211333)

> Beware that on FAT file systems the granularity is 2s. I doubt they are much used for source trees today though.

Alan Donovan, [Go tools](https://go-review.googlesource.com/c/tools/+/754320/comment/cf06a97b_0469840a/)

> `total_samples` is a `u64` in the header (`HDR_SIZE_SAMPLES` is 8), so `"=I"` here only reads half of it. On big-endian (the s390x buildbots) this reads the high word and the assert will fail. Can we read 64 bytes and unpack with `"=Q"`? btw `TestBinaryFormatValidation` below already has `HDR_OFF_SAMPLES = 28`, maybe we can reuse it.

pablogsal, [CPython](https://github.com/python/cpython/pull/152892#discussion_r3791848918)

> This absolutely should happen irrespective - we are changing the memory allocator on the toolchain and the tests should be running with that memory allocator.

compnerd, [Swift](https://github.com/swiftlang/swift/pull/82188#discussion_r2140820931)

### State left behind
`isolation_cleanup`

> This gets created before we know whether there will be any sharding, so with a read-only parent the run dies in `mkdtemp`, and `--corpus-shards 1` doesn't avoid it. It also survives a `SIGTERM`, left next to the corpus.
> And since the `with` wraps the collection loop too, the removal only happens after the last job, with everything else idle. 31s on macOS.

jeanpablojp, [Bitcoin Core](https://github.com/bitcoin/bitcoin/pull/36121#discussion_r3895026578)

> `SSL_set0_rbio` takes ownership here, but `inbio` remains non-NULL. If any later assertion fails, cleanup reaches `SSL_free(ssl)` and then `BIO_free(inbio)`. I forced the sequence assertion to fail under ASan and got a heap-use-after-free.
> Nulling `inbio` after the ownership transfer is one straightforward way to avoid that failure path. The existing test above appears to have the same pattern.

idrassi, [OpenSSL](https://github.com/openssl/openssl/pull/32064#discussion_r3663113234)

> It may be useful to add a test that runs this logic `500` times to ensure kubelet is not leaking any resources.
> Also continuous and fast failures (without any back off) is a new expected behavior here. See  https://github.com/kubernetes/kubernetes/issues/108152

SergeyKanzhelev, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/132933#discussion_r2229353038)

## Correct test code

### A bug in the test itself
`test_logic_bug`

> The `Pick` method can be called multiple times concurrently. This implementation can result in a `panic` since it can result in closing a channel multiple times. Instead of this, you can use an Event.
> https://github.com/grpc/grpc-go/blob/master/internal/grpcsync/event.go

arjan-bal, [gRPC-Go](https://github.com/grpc/grpc-go/pull/8923#discussion_r2839906673)

> i'm struggling to understand your current approach. if the `waitForSuccess` goroutine finishes, that will cancel this goroutine causing `waitE` to return an error and thus the test will fail.
> Why can't we simply run 2 goroutines: 1 with `waitForJobSuccess` and one which manages the full lifecycle of failure injection? if the backup job fails, i.e. `waitForJobSuccess` errors, only then should we cancel the context of the failure injection goroutine.

msbutler, [CockroachDB](https://github.com/cockroachdb/cockroach/pull/165365#discussion_r2953554957)

> this is confusing and I don't think it's correct ... APIServices that come from CRDs always have a nil spec.service
> https://github.com/kubernetes/kubernetes/blob/master/pkg/controlplane/controller/crdregistration/crdregistration_controller.go#L213-L221
> what is this trying to short-circuit on?
> /hold

liggitt, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/138128#discussion_r3028407799)

> The `stay_in_critical_native` and `native_counter` should be std::atomic and not volatile for mutli-threading correctness in C++.

lmesnik, [OpenJDK](https://github.com/openjdk/jdk/pull/30936#discussion_r3150454284)

## Weakening

### A test weakened, skipped or removed
`weakened_or_removed`

> I think you can just disable that one test on wasm. It doesn't fault on a nil pointer read like other archs do.

Keith Randall, [Go](https://go-review.googlesource.com/c/go/+/804320/comment/0331210f_06ec0bd6/)

> I think it is unlikely that this test reproduces the original problem. Fuzzlyn found that we need a collectible ALC for the test (that impacts our codegen for static access), and that's a bit of a pain to set up correctly in the regression tests. I would probably just skip the regression test and rely on the Fuzzlyn testing.

jakobbotsch, [.NET runtime](https://github.com/dotnet/runtime/pull/127746#discussion_r3441439804)

> Could we some how keep this test by modifying the GC's behavior, e.g. forwarding `__CARGO_PACKFILE_LIMIT` to `gc.auto`?  Looks like those have the same meaning

epage, [Cargo](https://github.com/rust-lang/cargo/pull/16459#discussion_r2864943713)

## Fit with the project

### An existing helper or harness
`reuse_test_infra`

> Would it make sense to put these tests into KASAN KUnit tests in
> mm/kasan/kasan_test_c.c? I assume there is a kernel API to JIT BPF
> programs from the kernel itself?
> There, you can just call kasan_poison(), some tests already do this.
> And you can also extend the KASAN KUnit test framework to find out
> whether the bad access is a read or write, if you want to check this.

Andrey Konovalov, [bpf](https://lore.kernel.org/bpf/CA+fCnZekgcEgsZnRrOB=+HoG=neRg=oLTt2jStyrPJ6mYf2ctQ@mail.gmail.com/)

> Please use [`loom::model`] for testing.
> [`loom::model`]: https://docs.rs/loom/0.7.2/loom/fn.model.html

ADD-SP, [Tokio](https://github.com/tokio-rs/tokio/pull/7418#discussion_r2188236030)

> This is fine, but you might prefer to re-use packages.Load(LoadSyntax), which produces typed syntax trees, for symmetry. Then you can reuse L386-405 changing only the mode flags.

Alan Donovan, [Go tools](https://go-review.googlesource.com/c/tools/+/769780/comment/fe7c97c1_511571a6/)

### A better kind of test
`different_technique`

> This whole thing seems too complicated to have confidence in.
> Could we have a test that "fuzzes" concurrently to try to detect further problems?

bboreham, [Prometheus](https://github.com/prometheus/prometheus/pull/16957)

> I think you should also consider adding end-to-end test of this functionality - e.g. a test of `snprintf` invocation which prints converted wide characters to a multi-byte sting, and a test case in `libc/test/src/stdio/printf_core/parser_test.cpp` to ensure that `%lc` is parsed correctly.
> For example, the Parser should accept the arguments of type `wint_t` in this case, according to specification - so probably you'd need to update the parsing code.

vonosmas, [LLVM](https://github.com/llvm/llvm-project/pull/169983#discussion_r2579062874)

> Thanks for adding these tests, but (i) they all appear to be testing `is_leaf`, which we want to remove, per above; (ii) they don't actually test the ABI behavior, which is visible only in the emitted code.
> Could you add some compile filetests instead, showing disassemblies with and without frame-pointer setup? In particular I'd expect the case where I commented and asked for #11573 to be filed to revert back to no-frame-pointer.

cfallin, [Wasmtime](https://github.com/bytecodealliance/wasmtime/pull/11581#discussion_r2314592277)

### Testing internals instead of behaviour
`implementation_coupling`

> Thinking again about this, I'd rather not see the test bound to the current GC implementation, since the problem is with the more general STW pauses.
> It would be best if this PR added a test function in `Modules/_testinternalcapi` that does a suitable STW pause, instead of calling `gc.collect()`.

dpdani, [CPython](https://github.com/python/cpython/pull/152826#discussion_r4081219011)

> Do we have to return these events to the test? These events are supposed to be guarded by the mutex and the test accesses them without the mutex. We should instead have methods in the fixture that wait for the new stream attempt to get blocked, and another method to unblock the previously blocked stream attempt.

easwars, [gRPC-Go](https://github.com/grpc/grpc-go/pull/9181#discussion_r3641988085)

> This test seems to depend on the internals of `net.sendFile`. It would really be better to have a self-contained test case, so modifications to `net` don't end up breaking this test. `sendFile` is also os-specific; it probably doesn't exist on some OSes (e.g. netbsd).
> (That said, `net.sendFile` probably isn't changing any time soon.)

Keith Randall, [Go](https://go-review.googlesource.com/c/go/+/684377/comment/579433e6_d9cd25b2/)

### Mocks that hide the behaviour
`mocking`

> `options.includeTopologyDescription()` is never checked. A test that registers a description with `status = AVAILABLE` and calls `describeStreamsGroups` without `includeTopologyDescription(true)` will get `AVAILABLE` back, which a real broker would never do (it returns `NOT_REQUESTED`). Tests using this mock cannot catch callers that forget to set the option. Should probably return `NOT_REQUESTED` when the option is false.

lucasbru, [Kafka](https://github.com/apache/kafka/pull/22636#discussion_r3453152150)

> In 6189a20491f71e3a6f499d2a510b38bb914e00d9 "test: Add tests for readonly database access"
> As in my previous comment regarding the tests in `db_tests.cpp`, the added tests in this file are not testing anything since `MockableDatabase` is not enforcing the read-only. These tests are definitely more useful conceptually than the `db_tests.cpp` tests since it is testing the call stack from the wallet level. However, I believe these would still pass if anything in that call stack would write things to the database.

achow101, [Bitcoin Core](https://github.com/bitcoin/bitcoin/pull/32685#discussion_r2136545485)

> This is not a good test because it mocks everything. Tests in `browser` run in Node.js and spawn Vitest process that runs the browser. You can look at other examples. Just add a new test with a project name that would fail previously and test that basic test ran correctly.

sheremet-va, [Vitest](https://github.com/vitest-dev/vitest/pull/9523#discussion_r2725706922)

## Readability and cost

### More than the test needs
`simplify_reduce`

> Setting `cfg.Timeout` here is what is causing the racing cancelations. This is why the tests had to be changed to check for two possible errors.  Let's pick which timeout we want to use simplify the tests to expect only one error.
> EDIT: Or, If these timeouts are both independently needed for a reason I'm missing, it should be possible to set up to that test them both individually (and don't have to check if either error was matched to decide if a test passes).

jpbetz, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/140512#discussion_r4104563465)

> Our `Semaphore` usage has two stages:
> 1. wait — used by the server handler to acquire permit to write the response
> 2. advance — used by the test method to allow the server handler to advance
> Can we simplify the design by replacing the usage of `Semaphore` with `CountDownLatch`? This will also avoid the need for a magical `RELEASE_ALL` constant.

vy, [OpenJDK](https://github.com/openjdk/jdk/pull/29415#discussion_r2738420131)

> i find the `recover` function returned here quite hard to reason about as it's an anonymous function that calls another anonymous function that spawns a goroutine. I think this logic would be easier to reason about if instead `waitAndInjectFailure` took in the jobID and was blocking. Then, within the func, it spins up two goroutines in a task.Group: one watching for job completion, and another doing failure injection shenanigans. If the job fails (tracked by goroutine 1), eagerly cancel the second goroutine.

msbutler, [CockroachDB](https://github.com/cockroachdb/cockroach/pull/165365#discussion_r2946936949)

### Repeated tests
`duplicate_or_parametrize`

> Make it a theory, and test two scenarios:
> - the handle is not on the allow list and does not get inherited
> - the handle is on the allow list and gets inherited
> it will help us to ensure that the ID generation and comparison logic is valid

adamsitnik, [.NET runtime](https://github.com/dotnet/runtime/pull/126629#discussion_r3057556541)

> Don't you need a dumplicate of this whole test in the workload registry for templates?

thockin, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/137271#discussion_r2933383683)

> I don't think we should duplicate the parsing logic in the test. The parsing in the non-test code may change without breaking the test. In my opinion, we don't need to add a test for verbosity level. If we were to write such a test, we would:
> 1. Make the env var a global. `var vLevel = os.Getenv("GRPC_GO_LOG_VERBOSITY_LEVEL")`
> 2. Create a constructor for the tLogger and call it from `init()`.
> 3. In the test, set the `vLevel` variable and call the constructor.

arjan-bal, [gRPC-Go](https://github.com/grpc/grpc-go/pull/8370#discussion_r2122902833)

### Wrong place or name
`placement_naming`

> Let's put this test in the `test_free_threading` directory. You can add a `test_free_threading/test_exceptions.py` that only contains this test.
> We only run a limited number of test suites under TSan (see https://github.com/python/cpython/blob/main/Lib/test/libregrtest/tsan.py) and we want this sort of test to be run with TSan because it's much better at catching data races than just seeing if things crashes.

colesbury, [CPython](https://github.com/python/cpython/pull/150578#discussion_r3325929419)

> I think this limits the `leakcheck` to only the `stats` package tests. init functions in test files don't run for importers. Since other packages import the non-test code of stats, all other tests will likely default to the no-op checker.

arjan-bal, [gRPC-Go](https://github.com/grpc/grpc-go/pull/8780#discussion_r2656851462)

> the test sets up hugepages, would it be better to run these in https://testgrid.k8s.io/sig-node-containerd#node-kubelet-containerd-hugepages using the `Fearture.HugePages`? Changing node setup may be affecting other tests.

SergeyKanzhelev, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/138127#discussion_r3343495139)

### Say what the test checks
`explain_test`

> to other reviewers: when we start a process and limit handle inheritance, it's hard to reliably check that given file handle/descriptor was not inherited because the OS can simply re-use the exact same number for a different pipe/file/device. The idea here is to get something that can help us identify given file handle and just compare the ID that parent and child processes have obtained.

adamsitnik, [.NET runtime](https://github.com/dotnet/runtime/pull/126629#discussion_r3059959756)

> I just realized this is potentially risky.  You're using the framer to read in the above goroutine and you're sending the framer to some other place in the code to use, but only for writing.  Just make sure it's very clear this can only be used for writing frames!

dfawley, [gRPC-Go](https://github.com/grpc/grpc-go/pull/8832#discussion_r2890815526)

> This test is named *WithoutUserActivation, so I'm confused why we're granting user activation to `rfh_a` here? Why doesn't it cause async beforeunload to be bypassed regardless of AsyncBeforeUnload feature? (More comments to explain the expected flow of the test would be great.)

Alex Moshchuk, [Chromium](https://chromium-review.googlesource.com/c/chromium/src/+/7413835/comment/276dc517_228ae37e/)

### Failures that do not say why
`diagnostics`

> Really we should do `TEST_true` if `handshakeok` and `TEST_false` otherwise. `TEST_true` and `TEST_false` have the side effect of printing diagnostic output if they fail - which is spurious in the event of `!handshakeok` in this PR. Generally we expect the `TEST_*` macros to always pass in our tests.

mattcaswell, [OpenSSL](https://github.com/openssl/openssl/pull/28859#discussion_r2425612279)

> Use `gomega.BeTrue` only as a very last resort. The failure message is not going to be useful when this times out because none of the things which are being checked are visible to gomega.
> Instead, let the Go code return a `*v1.Pod` and check the expected fields with `gomega`.

pohly, [Kubernetes](https://github.com/kubernetes/kubernetes/pull/134942#discussion_r2498623029)

### A slow or heavy test
`cost`

> When I try enabling HTTP/3 tests again on top of this CL, I'm noticing that this test fails because 1 minute exceeds QUIC's default idle timeout of 30 secs.
> Thoughts on decreasing this? Kind of hacky I suppose, but this is synctest, so not like the time particularly matters.

Nicholas Husin, [Go](https://go-review.googlesource.com/c/go/+/814300/comment/8bbcb742_4205f41c/)

> Have you measured how long this test takes now? With `1 << 16` the unwinder has to build 65536 `TaskInfo` nodes (several remote reads each) before the error fires, and the target holds ~65k live tasks. I am a bit worried about slow buildbots timing out inside `busy_retry`. Wouldn't something like `1 << 12` be more than enough for real programs?

pablogsal, [CPython](https://github.com/python/cpython/pull/153365#discussion_r3650274418)

> Since this is a StackOverflow test where the interesting bit is in the handling of the StackOverflow, I suggest requiring JSC option `maxPerThreadStackUsage` to set the stack to something smaller e.g 128K or 256K to shorten the test run time.  The current default limit is 5M, which I think is overkill for this test.

MenloDorian, [WebKit](https://github.com/WebKit/WebKit/pull/61721#discussion_r3012617667)
