import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const host = createJiti(process.argv[1] ? realpathSync(process.argv[1]) : import.meta.url);
const sdk = createJiti(host.esmResolve("@earendil-works/pi-coding-agent"));

// Resolve import-only exports from the host SDK, not the extension's optional
// peer tree. The cached helper has no serializer export list to become stale.
export function loadNative(specifier) {
	return require(fileURLToPath(sdk.esmResolve(specifier)));
}
