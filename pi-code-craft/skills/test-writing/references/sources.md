# The projects' own testing guides

The review data says what maintainers ask for in practice. These guides are
where several of the same projects wrote it down. Read the one for the
project or ecosystem you are working in; where it disagrees with this skill,
follow the project.

| Guide | What it adds |
|---|---|
| [LLVM Testing Infrastructure Guide](https://llvm.org/docs/TestingGuide.html) | Regression tests are minimal `lit` files with `FileCheck` lines; reduce inputs; generate check lines with the `update_*_test_checks.py` scripts. |
| [Go Test Comments](https://go.dev/wiki/TestComments) and [Google Go style: tests](https://google.github.io/styleguide/go/decisions) | Failures say what was tested, what came back and what was expected (`got`, `want`); compare whole structures and print diffs; table-driven tests; `t.Error` to keep going, `t.Fatal` only when the rest cannot run; mark helpers. |
| [Software Engineering at Google, ch. 12: Unit Testing](https://abseil.io/resources/swe-book/html/ch12.html) | Test via public APIs; test state, not interactions; test behaviours, not methods; no logic in tests; clear failure messages; DAMP over DRY. |
| [Software Engineering at Google, ch. 13: Test Doubles](https://abseil.io/resources/swe-book/html/ch13.html) | Prefer real implementations, then fakes, then stubs and mocks; interaction checks only when the interaction is the contract. |
| [Rust compiler: test best practices](https://rustc-dev-guide.rust-lang.org/tests/best-practices.html) | Minimal tests with meaningful names; a comment saying what the test checks; a reason beside every `ignore-*` directive; flaky tests are "worse than not having the test". |
| [Kubernetes: writing good e2e tests](https://github.com/kubernetes/community/blob/main/contributors/devel/sig-testing/writing-good-e2e-tests.md) | Debuggable failures, no fixed sleeps, timeouts as upper bounds, tests that tolerate a busy cluster. |
| [Testing in Chromium](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/testing/testing_in_chromium.md) | Which kind of test belongs where; how flaky tests are found and disabled with a bug. |
| [KUnit test style](https://docs.kernel.org/dev-tools/kunit/style.html) | Kernel unit test layout and naming. |
| [git's t/README](https://github.com/git/git/blob/master/t/README) | Shell test rules: prerequisites for platform needs, `test_when_finished` for cleanup, chaining with `&&` so a failing step fails the test. |
| [Django: submitting contributions](https://docs.djangoproject.com/en/dev/internals/contributing/writing-code/submitting-patches/) | A bug fix comes with a regression test that fails without the fix. |
| [Test Desiderata](https://testdesiderata.com/) | Kent Beck's list of test properties (isolated, deterministic, fast, behavioural, structure-insensitive, specific, predictive) and the trade-offs between them. |
