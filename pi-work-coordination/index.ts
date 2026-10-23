import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISCOVER_COORDINATION = "pi-work/discover-coordination-v1";

/** True in an SDK child session that pi-agents runs as a secondary agent: its parent's runtime owns its turns. */
export function isManagedChild(pi: ExtensionAPI): boolean {
  const probe = { installed: false, child: false };
  pi.events.emit(DISCOVER_COORDINATION, probe);
  return probe.installed && probe.child;
}

/** Records, once per event bus, whether this session is a root or a managed child (SDK children pass child: true). */
export function ensureWorkCoordination(pi: ExtensionAPI, options: { child?: boolean } = {}): void {
  // Each ExtensionAPI has a different events facade. Probe through the actual shared bus instead of comparing facade
  // identities. Pi's emit invokes the synchronous portion of listeners before returning, so probe and claim have no
  // await gap. The host also removes this listener if its factory fails.
  const probe = { installed: false };
  pi.events.emit(DISCOVER_COORDINATION, probe);
  if (probe.installed) return;
  const releaseClaim = pi.events.on(DISCOVER_COORDINATION, (value) => {
    if (value && typeof value === "object" && "installed" in value) {
      (value as { installed: boolean }).installed = true;
      (value as { child?: boolean }).child = options.child === true;
    }
  });
  pi.on("session_shutdown", () => releaseClaim());
}
