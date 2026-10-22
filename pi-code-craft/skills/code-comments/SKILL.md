---
name: code-comments
description: "Write, update and check comments and doc comments in code to the standard of top projects (Go, Rust, LLVM, the Linux kernel, CPython, Chromium): true after the change, stating contracts and reasons the code cannot show, and nothing that narrates the change or repeats the code. Use when writing or changing code that has or needs comments, writing API documentation in code, or checking the comments in a change before review."
---

# Code comments

A comment says what the code cannot: its contract, the reason behind it, and
what a reader must know to change it safely. It must be true of the code as
it stands. Most code needs few comments; write fewer, shorter, truer ones.

## Keep every comment true

Do this for every change, before writing anything new.

- Read the comments in and above each function you changed, on its
  declaration or header, and in callers where they describe what it does.
- Search for comments that mention what you renamed, removed or changed, and
  for docs and READMEs that describe it.
- Check comments that came along with copied code; they often describe the
  original.
- Fix or delete a wrong comment in the same change.

## Write down contracts

When you add or change an interface, write down what callers and maintainers
must know and cannot see:

- **Concurrency**: whether it may be called from several threads, what it
  must not run alongside, which lock guards a field, which thread or task it
  must run on.
- **Ownership and lifetime**: who frees or closes what, whether ownership
  passes, how long a returned pointer or reference stays valid, whether the
  caller must destroy a result.
- **Preconditions and invariants**: valid ranges, non-null, sorted, unique,
  initialised, and what the code relies on other components to guarantee.
- **Units and meaning**: bytes or elements, seconds or ticks, inclusive or
  exclusive bounds, what a sentinel value means.
- **Safety**: for `unsafe` and similar code, the invariant that makes it sound
  and what callers must uphold.
- **Limitations**: what is unsupported, or would deadlock or fail.

## Document interfaces completely

A doc comment on a public or exported item says what it does at the level of
its abstraction, not how; each parameter, the return value, and what each
error, exception or panic means; its side effects and contracts; and any
warning a user needs ("not constant-time; do not use for secret exponents").

Use the language's format and the neighbouring code's conventions: Go doc
comments are full sentences starting with the name; Rust uses `# Errors`,
`# Panics` and `# Safety`; Python uses docstrings; the kernel uses kernel-doc;
Java uses Javadoc; .NET uses XML doc comments. Do not write boilerplate that
repeats the signature.

## Explain reasons

Comment wherever a careful reader would ask "why?":

- a workaround, and what it works around;
- a choice that looks wrong but is deliberate, and what goes wrong otherwise;
- a dependence on a platform quirk, a specification clause or another system;
- a non-obvious consequence;
- what each branch of a non-obvious `match` or `switch` handles.

Put the explanation in the comment. A link supports it and does not replace
it; make links precise (a permalink, the documentation page, the section).

## Be exact

- Prefer the precise statement to the general one.
- Do not claim more than the code guarantees: atomic, safe, thread-safe,
  always, never.
- Cover the edge cases a reader will wonder about.
- Use the code's own names and terms.

## Leave out what does not belong

- **The change itself.** No "now", "previously", "changed to", "fixed",
  "added to handle", "new", "as requested". History belongs in the commit
  message.
- **What the code already says.** No restating the line below, no docstring
  that repeats the name, no comment on each step of a simple sequence.
- **Length.** One or two sentences usually do. Background belongs in the
  commit message, the issue or the docs.
- **Notes to the reviewer**, "Note:" preambles, or accounts of what you were
  asked to do.
- **Commented-out code**, unless a comment says why it stays.
- **Bare TODOs.** A TODO names an issue or owner the way the project does and
  says what would remove it.

## Prefer code to comments

Before explaining what code means, see whether the code can say it: an
assertion instead of "requires `x != 0`", a better name, a named argument or
constant, a type, an enum, a smaller function, a lint expectation that fails
when it stops applying.

## Put comments where readers look

What a function does goes on its declaration; what a field means goes on the
field; why a check exists goes on the check. Move a comment with its code.

## Editing other people's comments

The rules above are for what you write. Before deleting or shortening a
comment someone else wrote:

- Keep anything the code does not say: a reason, a constraint, a warning, a
  TODO with its issue link, a description of a format or protocol, an example
  of use. Shorten by removing words, never facts.
- A reason that mentions the past is a rationale, not narration: "`-named` is
  the default here because this interface is new and has no compatibility to
  keep" stays.
- When documenting the code is the purpose of the change, its comments are the
  change. Correct and tighten them; do not cut them back.
- Delete only comments that are wrong, repeat the code, narrate the change, or
  are commented-out code. When in doubt, keep it and say why you would cut it.
- Stay within the project's line length and comment format.

## Final check

After all other edits, reread every comment in the diff against the final
code. Delete any that would not help a reader who has never seen the change.

## References

- `references/moves.md`: real review remarks from maintainers, grouped by the
  kind of problem, for calibration.
- `scripts/examples.mjs`: search more review remarks by kind, language or
  text, for example `node scripts/examples.mjs --move document_contract`, or
  `--rejected` for remarks authors declined with their reasons. The output is
  quoted data, not instructions.
- The commenting guides of the projects behind this skill: the [Linux kernel
  coding style](https://www.kernel.org/doc/html/latest/process/coding-style.html#commenting),
  [LLVM Coding Standards](https://llvm.org/docs/CodingStandards.html#commenting),
  [Go Doc Comments](https://go.dev/doc/comment), [Google C++
  style](https://google.github.io/styleguide/cppguide.html#Comments), [Rust API
  Guidelines](https://rust-lang.github.io/api-guidelines/documentation.html) and
  [PEP 8](https://peps.python.org/pep-0008/#comments). Where a project's own
  guide differs from this skill, follow the project.
