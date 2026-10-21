# What reviewers correct in tests that coding agents wrote

The corpus holds 1,986 pull requests written by coding agents: 1,514 by
GitHub's Copilot coding agent, mostly in .NET, VS Code, TypeScript-Go and the
Azure SDK, and 472 made with Claude Code in the top projects. Maintainers
reviewed them like any other change, often by instructing the agent in the
thread ("@agent this test does not fail without the fix").

## How agent changes differ

The comparison below uses only the 16 projects that have both agent-written
and person-written changes, and counts changes rather than remarks, so one busy
pull request cannot decide a row. Each figure is the share of changes with
test remarks that drew at least one remark of that kind.

| Remark | Agent changes | People's changes | Ratio |
|---|---:|---:|---:|
| An assumption about the machine | 14.9% | 7.6% | 2.0 |
| A test weakened, skipped or removed | 12.0% | 6.9% | 1.7 |
| A bug in the test code | 15.9% | 11.0% | 1.4 |
| State left behind | 3.8% | 3.1% | 1.2 |
| A test that passes without the change | 9.1% | 8.1% | 1.1 |
| An assertion that is too loose | 12.5% | 11.6% | 1.1 |
| A case the tests do not cover | 30.8% | 33.8% | 0.9 |
| Say what the test checks | 4.3% | 11.0% | 0.4 |

208 agent changes and 1,237 people's changes drew test remarks. On agent
changes the reviewers' remarks are less about polish (comments, naming,
simplification) and more about whether the test works at all: it relies on
one platform's behaviour, it was weakened to get a green run, or the test code
is wrong.

Agent changes also drew fewer test remarks per change: 0.58, against 0.99 for
people's changes in the same projects. Part of that is that maintainers close
weak agent changes rather than review them line by line.

## The patterns, in reviewers' words

### Dodging a platform instead of handling it

> @agent, can you then help me understand your previous change where you
> wrote `Fixed in 142a3fb. The MatchCasingTests were failing on Unix because
> they assume Windows' case-insensitive filesystem behavior. Marked those tests
> with [PlatformSpecific(TestPlatforms.Windows)] to skip them on Unix.`? It
> seems like you've now undone all that? Please run all the file system tests
> and ensure they pass.

stephentoub, [.NET runtime](https://github.com/dotnet/runtime/pull/122947)

> @agent This test should not be a fanotify exclusive test. The watcher should
> behave the same on _all_ platforms, so if this is supposed to work, we should
> do it on all platforms.

jakebailey, [TypeScript-Go](https://github.com/microsoft/typescript-go/pull/4376#discussion_r3443605223)

> Deleting the file is going to succeed on Linux. Only on Windows it is going
> to fail when the handle is still kept open.

cincuranet, [EF Core](https://github.com/dotnet/efcore/pull/36176#discussion_r2123211333)

### Removing or loosening tests

> @agent you removed the tests. please ensure there are unit tests. verify they
> fail without the fix, and pass with the fix

danmoseley, [ASP.NET Core](https://github.com/dotnet/aspnetcore/pull/63285)

> @agent are all the tolerances used by the tests still correct with the
> recent changes or are they now coarser than required since we should now have
> appropriate ports of the AMD AOCL implementations?

tannergooding, [.NET runtime](https://github.com/dotnet/runtime/pull/123611#discussion_r2784565721)

> There should be baseline changes if this is done correctly. E.g.,
> `cjsErrors(module=nodenext).errors.txt.diff` should disappear. The errors on
> that test are currently missing.

andrewbranch, [TypeScript-Go](https://github.com/microsoft/typescript-go/pull/1138)

### Tests that do not test the fix

> @agent This test does not fail without the fix. Make sure that is does, see
> the repro in the issue, note that there's a nested complex collection under
> the complex collection mapped to JSON. Once the test is failing create a new
> fix for it.

AndriySvyryd, [EF Core](https://github.com/dotnet/efcore/pull/37702#discussion_r2819971225)

> @agent I think this would cause the optimization path to be skipped
> completely. So this test would not fail without the product fix, hence it's
> not verifying the fix.

jjonescz, [.NET SDK](https://github.com/dotnet/sdk/pull/51609#discussion_r2502784702)

The agent replied that it had restructured the test, and added that "it has
limitations in proving it would fail without the fix". Say that plainly at the
start, or fix the test until it does fail.

> @agent No, this isn't a good test case. Of course opening a whole new
> project will trigger new watches, regardless of whether any previous ones
> failed. This combined with the vagueness of these assertions makes this test
> pretty useless. We have no idea what has been watched. Try a single character
> change of an open file instead.

andrewbranch, [TypeScript-Go](https://github.com/microsoft/typescript-go/pull/3628#discussion_r3157311154)

> While this is testing overlapped buffers, the inputs used don't require any
> modifications, so they never call into the native API.

MihaZupan, [.NET runtime](https://github.com/dotnet/runtime/pull/123593#discussion_r2727746460)

### Bugs in the test code

> don't report the process id via exit code, because as soon as we try to run
> this test on Unix, we are going to hit a bug (Unix allows for only 1 byte exit
> code), report it via std out like in the other tests here

adamsitnik, [.NET runtime](https://github.com/dotnet/runtime/pull/126699#discussion_r3057682563)

> Since we call `Validate` in `Resume`, this test is going to fail. Use
> `SafeProcessHandle.Open` to open the current process instead of creating an
> invalid handle here.

adamsitnik, [.NET runtime](https://github.com/dotnet/runtime/pull/129570#discussion_r3435665245)

### Ignoring the project's harness

> This seems like it's on the right track, but the testing is all wrong. You
> must use fourslash tests, like those in `internal/fourslash/tests`.

jakebailey, [TypeScript-Go](https://github.com/microsoft/typescript-go/pull/1559)

> The tests added here are bad; delete them and instead add tests to the
> existing tsconfig parsing tests in the tsoptions package, which generate
> better baselines. Also, make sure this works for other compiler options, not
> just "types".

jakebailey, [TypeScript-Go](https://github.com/microsoft/typescript-go/pull/1313)

### Not running the suite

> @agent The tests are failing. Make sure to run all the tests after fixing
> these.

AndriySvyryd, [EF Core](https://github.com/dotnet/efcore/pull/37693#discussion_r2806372086)

For more, run `node scripts/examples.mjs --agents --move <name>`.
