import { imageRejections, withoutUnreadableImages } from "./image-check.ts";
import { withRecordedStubs } from "./superseded.ts";

type Message = Parameters<typeof withoutUnreadableImages>[0][number] & Parameters<typeof withRecordedStubs>[0][number];
type Branch = Parameters<typeof imageRejections>[0] & Parameters<typeof withRecordedStubs>[1];

/**
 * The messages as the conversation's requests have sent them: the stubs recorded for superseded tool results, and
 * notes in place of images the provider could not read. For code that rebuilds a request outside Pi's request hooks,
 * as Codex compaction does: a request with the original results or images differs from the conversation's own from
 * the first of them, and one with an unreadable image is refused.
 */
export function sentMessages<T extends Message>(messages: T[], branch: Branch): T[] {
	const stubbed = withRecordedStubs(messages, branch) ?? messages;
	return withoutUnreadableImages(stubbed, imageRejections(branch)) ?? stubbed;
}
