# What gets comments rejected, and how comments that land are written

## Why authors reject review comments

When an author declines a comment, the reply gives one of a few reasons. Each
has a check that would have caught it before the comment was written.

**"That is not what the code does."** The reviewer described code they had
not fully read, or an API they had not checked. AI reviewers lose this
argument far more often than people do. *Check:* open the file and the callee
and cite the lines.

> Claude in [systemd](https://github.com/systemd/systemd/pull/42272#discussion_r3293230491)
> said a cpio path should be absolute. The author: "This is a wrong
> suggestion. The absolute path is used for reading, as the archive is
> extracted relative to /. The archive itself must use relative paths, which
> is exactly what stub already does" (with a link to the line).

**"It is already handled."** The guard sat above the hunk, in a caller, or in
a type invariant. *Check:* read the whole function and its callers before
claiming a case is missed.

> Gemini in [Envoy](https://github.com/envoyproxy/envoy/pull/45617#discussion_r3414054055)
> asked for a runtime-flag guard. The author: "The stream close optimization
> under this function is guarded by the below check early on in this
> function."

**"That is deliberate."** The behaviour was a design decision, often already
discussed. This is the most common reason of all, for people and AI alike.
*Check:* the description, the discussion, code comments, and whether the code
follows an existing convention. If you think the decision is wrong, argue
with the decision; do not report it as a bug.

> Copilot in [.NET](https://github.com/dotnet/runtime/pull/124893#discussion_r2954670146)
> reported a race between `Register` and `Unregister`. The author: "This was
> discussed above. We do not want s_registerLock in Unregister."

**"Not worth it."** The fix costs more code, complexity or time than the
problem warrants. *Check:* state the consequence. If it is a worse error
message in a test, or a defensive assert on an impossible path, leave it out.

> Copilot in [.NET](https://github.com/dotnet/runtime/pull/124893#discussion_r2930466890)
> asked a test to guard against `null` and add a timeout. The author: "too
> much code for minimal benefit. If it fails in any way, we get exception and
> test fails."

**"Not this change."** The problem predates the change, or belongs in another
one. *Check:* compare with the base version. If it is pre-existing, say so,
and raise it only if it is serious or the change makes it reachable.

**"Your alternative changes behaviour."** A suggested replacement that is not
equivalent. *Check:* run the alternative over the edge inputs before
proposing it.

> Claude in [systemd](https://github.com/systemd/systemd/pull/43274#discussion_r3734157371)
> proposed replacing a helper with an existing function. The author had
> checked: `extract_first_word("", …)` returns no word, so `opt=` would become
> `NULL` instead of `""`.

**"Taste."** Naming, structure and consistency preferences the author does
not share. It is the second most common reason people's comments are
declined. *Check:* is the convention written down, or does the inconsistency
mislead someone? Otherwise drop it.

Run `node scripts/examples.mjs --rejected --ai` for more rejected comments with
the author's reply.

## When to ask instead of assert

Questions are almost never rejected. Either the author finds a problem and
fixes it, or the author explains and the reviewer learns something. Top
reviewers ask often; AI reviewers almost never do. Ask when you have a
plausible concern that you could not settle from the code. Name the case:

> Umm. I don't see how this avoids deadlock. […] A takes mmap_read_lock /
> B tries to take mmap_write_lock, blocks / A calls copy_from_user() / […] /
> Deadlock because B is waiting for A to release the mmap_read_lock. Am I
> missing something?

Matthew Wilcox, [linux-mm](https://lore.kernel.org/linux-mm/anbZpzFbtYG7Ngit@casper.infradead.org/)

Do not ask about code you have not read. "Is this thread-safe?" with no
scenario sends the author to do your reading.

## How comments that land are written

1. **Point at the mechanism, not the symptom.** "`SSL_set0_rbio` takes
   ownership here, but `inbio` remains non-NULL", not "possible memory issue".
2. **Give the scenario**: an input, an interleaving or a call chain.
3. **State the consequence.** "the client will discard the wrapped records";
   "You will leave a gap in watch history."
4. **Offer the fix or the precedent.** "Look at `try_reduce_contiguous` for an
   example that does this correctly"; "Check `cpuCFSQuotaPeriod` at line 81
   for the upgrade-safe pattern."
5. **Prove it when it is cheap.** "I forced the sequence assertion to fail
   under ASan and got a heap-use-after-free"; "I tried starting the new test at
   `fffffffffffd`."
6. **Match confidence to evidence.** "This is wrong" when you have checked; "I
   think" or "am I missing something?" when you have not. Both land; a
   confident claim that turns out false does not.

What the strongest reviewers leave out: restating what the diff does, praise,
formatting a linter enforces, and generic advice such as "consider adding
tests" or "consider error handling" without the case.
