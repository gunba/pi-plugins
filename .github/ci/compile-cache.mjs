import { enableCompileCache } from "node:module";
import { join } from "node:path";

/** Cache compilation, never module execution; coverage jobs need fresh V8 instrumentation. */
export function enableBytecodeCache(root) {
  if (process.env.NODE_V8_COVERAGE || process.env.NODE_DISABLE_COMPILE_CACHE === "1") return;
  const directory = join(root, "node_modules/.cache/ci-bytecode");
  process.env.NODE_COMPILE_CACHE = directory;
  enableCompileCache(directory);
}
