import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { compileFunction } from "node:vm";
import type { Jiti, JitiOptions, ModuleCache, TransformOptions, TransformResult } from "jiti";

// These exact MIT-licensed artifacts are shipped by jiti@2.7.0. No patched
// bundle is stored, installed or entered into Node's native module cache.
const VERSION = "2.7.0";
const EVALUATOR_SHA256 = "a0b3b8d5e06a0519c66b62179e29200533057920f6f11370546e979dacd24c49";
const TRANSFORMER_SHA256 = "b3bc89a8dc40860fb6a7a78512bdfe5976c6253e6ded74b7d96ece803cac8701";

function verifiedSource(bytes: Buffer, expected: string, label: string): string {
	if (createHash("sha256").update(bytes).digest("hex") !== expected) {
		throw new Error(`Child module isolation requires the audited jiti@${VERSION} ${label}; source hash differs. Re-audit the adapter before updating Jiti.`);
	}
	return bytes.toString("utf8");
}

/** Pure patch boundary, exported for fail-closed regression tests. */
export function patchJitiEvaluator(bytes: Buffer, version: string): string {
	if (version !== VERSION) throw new Error(`Child module isolation requires jiti@${VERSION}; found ${version}.`);
	let source = verifiedSource(bytes, EVALUATOR_SHA256, "evaluator");
	const patches: Array<[string, string]> = [
		// Keep one interop wrapper per exported object in this graph. Native-style
		// CJS mutation requires live property reads, not Jiti's memoized values.
		['function jitiInteropDefault(e,t){return',
			'function jitiInteropDefault(e,t){const cache=e.opts.__piChildInterop,object=t!==null&&(typeof t==="object"||typeof t==="function");if(object&&cache.has(t))return cache.get(t);const result='],
		['}(t):t}let Ei;', '}(t):t;if(object)cache.set(t,result);return result}let Ei;'],
		['if(E.has(n))return E.get(n);let c;return', 'let c;return'],
		['E.set(n,c),c},apply:l?', 'c},apply:l?'],
		// Jiti otherwise native-imports .mjs, .cjs and module-mode .js even with
		// tryNative/moduleCache disabled. Force transpilation throughout this graph.
		["S=n.forceTranspile??(!C&&!(w&&n.async)&&(E||w||t.isTransformRe.test(c)||hasESMSyntax(i)))", "S=!0"],
		// JSON imports must share an object inside this graph, not native require's
		// mutable object with a parent/other child. Preserve Jiti's default interop.
		['const t=e.nativeRequire(a);return t&&!("default"in t)',
			'const t=(n[a]??=( {exports:JSON.parse((0,$e.readFileSync)(a,"utf8").replace(/^\\uFEFF/,"")),loaded:!0} )).exports;return t&&!("default"in t)'],
		// Only actual native addons may use the unknown-extension native route.
		['if(c&&!e.opts.extensions.includes(c))return debug(e,"[native]","[unknown]",i.async?"[import]":"[require]",a),nativeImportOrRequire(e,a,i.async);',
			'if(c&&!e.opts.extensions.includes(c)){if(c!==".node")throw new Error("Unsupported isolated child module extension: "+c);return nativeImportOrRequire(e,a,i.async)}'],
		// Explicit data: imports would bypass the isolated file graph. Jiti's own
		// generated-function fallback uses nativeImport directly and is unchanged.
		['return debug(e,"[native]","[data]","[import]",t),nativeImportOrRequire(e,t,!0)',
			'throw new Error("Isolated child providers cannot import data: module URLs")'],
	];
	for (const [before, after] of patches) {
		if (source.split(before).length !== 2) throw new Error("Audited Jiti isolation patch site changed; refusing to load child providers.");
		source = source.replace(before, after);
	}
	return source;
}

type CoreFactory = (id: string, options: JitiOptions, internals: {
	onError: (error: unknown) => never;
	nativeImport: (id: string) => Promise<unknown>;
	createRequire: typeof createRequire;
	parentCache: ModuleCache;
}) => Jiti;

let auditedRuntime: Promise<{ create: CoreFactory; transform: NonNullable<JitiOptions["transform"]> }> | undefined;
function loadAuditedRuntime() {
	return auditedRuntime ??= (async () => {
		const require = createRequire(import.meta.url);
		const packagePath = require.resolve("jiti/package.json");
		const root = dirname(packagePath);
		const evaluatorPath = join(root, "dist", "jiti.cjs");
		const transformerPath = join(root, "dist", "babel.cjs");
		const [metadata, evaluator, transformer] = await Promise.all([
			readFile(packagePath, "utf8"), readFile(evaluatorPath), readFile(transformerPath),
		]);
		const patched = patchJitiEvaluator(evaluator, JSON.parse(metadata).version);
		verifiedSource(transformer, TRANSFORMER_SHA256, "transformer");
		const packageRequire = createRequire(evaluatorPath);
		const module = { exports: {} as unknown };
		compileFunction(patched, ["exports", "require", "module", "__filename", "__dirname"], { filename: evaluatorPath })(
			module.exports, packageRequire, module, evaluatorPath, dirname(evaluatorPath),
		);
		if (typeof module.exports !== "function") throw new Error("Audited Jiti evaluator did not export its factory.");
		const transform = packageRequire(transformerPath) as (options: TransformOptions) => TransformResult;
		return { create: module.exports as CoreFactory, transform };
	})();
}

/** One private module cache for ALL entrypoints imported through this instance. */
export async function createIsolatedJiti(id: string, virtualModules: Record<string, unknown>): Promise<Jiti> {
	const { create, transform } = await loadAuditedRuntime();
	const options: JitiOptions & { __piChildInterop: WeakMap<object, unknown> } = {
		transform,
		moduleCache: false,
		interopDefault: true,
		__piChildInterop: new WeakMap(),
		tryNative: false,
		extensions: [".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".jsx", ".json"],
		fsCache: true,
		// Framework subpaths and native addons retain native identity. Public
		// package roots/legacy names are routed through virtualModules first.
		nativeModules: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"],
		alias: {},
		virtualModules,
	};
	return create(id, options, {
		onError(error) { throw error; },
		nativeImport: (specifier) => import(specifier),
		createRequire,
		parentCache: Object.create(null) as ModuleCache,
	});
}
