// Shared by Wire and the subagent adapter, including separately loaded jiti modules.
// A child must inherit the effective provider from this active Wire registration.
const key = Symbol.for("pi.codex-wire.required.v1");
type Registration = { check: () => boolean };
const global = globalThis as typeof globalThis & { [key]?: Map<string, Registration> };
const registrations = global[key] ??= new Map<string, Registration>();

export function registerRequiredWire(rootSessionId: string, check: () => boolean): () => void {
  const registration = { check };
  registrations.set(rootSessionId, registration);
  return () => {
    if (registrations.get(rootSessionId) === registration) registrations.delete(rootSessionId);
  };
}

export function requireCodexWire(rootSessionId: string): void {
  if (!registrations.get(rootSessionId)?.check()) {
    throw new Error("Cannot launch a Codex child without the active Codex Wire provider. Reload or repair Codex Wire first.");
  }
}
