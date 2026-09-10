# pi-local-links

Automatically bundled with `pi-plugins`. Resolves Markdown file links in
assistant replies and thinking blocks before Pi renders them.

For a session working in `C:/Users/Test`, this destination:

```text
AppData/Local/Temp/pi-clipboard.png
```

becomes:

```text
file:///C:/Users/Test/AppData/Local/Temp/pi-clipboard.png
```

## Behaviour

- Relative paths resolve against `ctx.cwd`, including `./` and `../`.
- Windows drive paths, backslashes, UNC paths and POSIX paths are supported.
  Absolute filesystem paths become file URLs without changing their location.
- `~/` expands to the local user's home directory (`~\` also works on Windows).
- Spaces, Unicode and already-encoded filename characters are handled.
- Link labels, titles and Markdown layout stay intact. Inline and reference
  links work, including links inside lists and blockquotes.
- Web links, other URI schemes, existing `file:` URLs, fragment-only links and
  protocol-relative web URLs stay unchanged.
- Code examples, plain paths, HTML, user messages and inline image syntax are
  not rewritten. Image-only reference definitions stay unchanged.
- Query strings and fragments retain URI semantics. Encode a literal filename
  `#` as `%23`. Ambiguous encoded path separators and invalid control characters
  are left untouched.

This uses Pi's public `registerMarkdownTransformer` API. It covers streaming
updates, restored messages and terminal redraws. It does not patch Pi, change
model context, rewrite saved sessions, access linked files or launch applications.
The terminal still handles Ctrl+click.

No settings or commands are needed. Restart Pi after installing the update.
Each session has its own directory and bounded render cache.

The extension resolves paths; it does not search for files or guess missing
directory prefixes. A path relative to the wrong directory still needs correction.
Custom-message and tool-output renderers are outside this hook.

## Tests

From the repository root:

```sh
node --test pi-local-links/tests/links.test.mjs tests/extension-loading.test.mjs
npm run typecheck
```

Tests cover Windows/POSIX resolution, encoding, Markdown structure, streaming,
restoration, session isolation, unchanged session bytes, and absolute OSC-8
targets emitted by Pi's renderer. They do not make model requests.
