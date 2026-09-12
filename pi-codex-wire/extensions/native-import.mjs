import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// Native resolution honours the SDK's import-only package exports without Pi's
// root aliases. This module has no SDK export list to become stale on /reload.
export function loadNative(specifier) {
	return require(fileURLToPath(import.meta.resolve(specifier)));
}
