# Isolated child extension loading

`isolated-jiti.ts` is a small, pinned adapter over **Jiti 2.7.0**. It does not vendor a bundle, edit `node_modules`, clear or replace native `require.cache` entries, or install global module hooks.

## Why the adapter is needed

Stock Jiti still uses native loading for `.mjs`, `.cjs` and package-type-module `.js` when both `moduleCache` and `tryNative` are false. Those paths reuse provider state between child activations. Its default interop proxy also caches property values, which breaks mutable CJS exports when CJS code is forced through the evaluator.

The adapter:

1. Resolves the installed public `jiti/package.json` entry.
2. Verifies the package version and exact evaluator/transformer SHA-256 hashes.
3. Applies narrowly matched patches to the evaluator **in memory**.
4. Evaluates that verified copy with `node:vm.compileFunction` and Jiti's package-scoped `require`.
5. Creates one private module cache and interop-wrapper cache per activation. Multiple entrypoint imports share those caches; a new activation gets new ones.

The patches force JavaScript/TypeScript graph transpilation, keep CJS interop reads live, preserve wrapper identity within the graph, and parse JSON into graph-local objects. Explicit `data:` imports and unknown code extensions fail rather than use unisolated native loading. Native addons (`.node`) remain native.

The Babel transformer remains the installed, verified native transformer. Transform-file caching stays enabled; cached transform text does not contain live provider state. Jiti environment settings cannot enable native-first loading, a global module cache or additional code-extension escape paths in this adapter.

## Native boundaries

Node builtins, native addons, Jiti/TypeScript's own runtime packages and Pi/typebox framework packages remain native/shared. Public framework entries are supplied through the same virtual-module aliases and `pi-ai` compatibility routing as the SDK loader. They are resolved from the SDK's public package entry so nested dependencies keep the correct identity.

This is **module-state isolation, not a security sandbox**. Trusted provider code still has native process APIs, filesystem access and `globalThis`. Code that explicitly creates a native loader with `node:module.createRequire`, launches another process, or stores state on `globalThis` is outside this graph's isolation boundary.

Abort checks prevent subsequent imports/factory work at asynchronous boundaries. Arbitrary synchronous code or an uncooperative pending factory cannot be forcibly stopped in-process. The caller must treat loader errors as fatal and dispose failed child sessions.

## Public helper integration

`../extensions/child-tool-extensions.ts` exports:

```ts
loadChildToolExtensions(options: {
  tools: ToolInfo[];
  handledToolNames: Iterable<string>;
  signal: AbortSignal;
  projectTrusted: boolean;
  getFlag?: (name: string) => boolean | string | undefined;
}): Promise<InlineExtension[]>
```

The result is empty if there are no unhandled extension tools; otherwise it contains one named wrapper, `inherited-tool-providers`. Spread that result into `DefaultResourceLoader.extensionFactories`.

Each wrapper invocation creates a new graph, then imports and invokes all authorized provider factories sequentially. Every provider gets a child API proxy that permits only its parent-owned tool names. Other registrations and lifecycle/policy hooks stay attached to the child. A supplied parent `getFlag` is authoritative, including `false` and `undefined`; there is no fallback to child defaults when it is supplied.

The wrapper is one SDK loading transaction: failure of any provider rejects the group. Error messages identify the failing source and owned tools. The driver owns active-tool selection, post-start availability checks, revocations and disposal. Descendants must continue using original root source metadata; SDK inline source labels are synthetic and cannot reconstruct a provider.

## Provenance and updates

Upstream: <https://github.com/unjs/jiti>, npm package `jiti@2.7.0`, MIT license reproduced in `LICENSE.jiti`.

Audited installed artifacts:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `dist/jiti.cjs` | 190,082 | `a0b3b8d5e06a0519c66b62179e29200533057920f6f11370546e979dacd24c49` |
| `dist/babel.cjs` | 1,526,691 | `b3bc89a8dc40860fb6a7a78512bdfe5976c6253e6ded74b7d96ece803cac8701` |

The snippets in the adapter derive from those MIT-licensed artifacts. No complete upstream bundle is stored here. The internal evaluator entrypoint and its context fields are deliberately version-bound; no SDK private API is used.

A version/hash mismatch fails closed. Before changing the Jiti dependency, audit the new evaluator's routing/cache/interop paths, update the exact patches and fingerprints, and rerun both suites:

```sh
node --test pi-subagents/tests/child-tool-extensions.test.mjs pi-subagents/loader/tests/isolated-jiti.test.mjs
npm run typecheck
```
