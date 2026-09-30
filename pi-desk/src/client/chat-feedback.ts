import type { Feedback } from "../shared/feedback.ts";
import type { CachedMessage } from "./state.ts";
import { noticeIdentity } from "./notice-dismissals.ts";
type FeedbackStorage = Pick<Storage, "getItem" | "setItem">;
const feedbackKey = "pi-desk:chat-feedback";

export function readFeedback(storage: FeedbackStorage): Record<string, Feedback[]> {
	try {
		const value = JSON.parse(storage.getItem(feedbackKey) ?? "{}");
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(Object.entries(value).slice(-20).flatMap(([key, records]) => Array.isArray(records) ? [[key,
			records.filter(item => item && typeof item.id === "string" && typeof item.text === "string" &&
				["error", "warning"].includes(item.level) && Number.isFinite(item.timestamp) && typeof item.generation === "string").slice(-80)]] : []));
	} catch { return {}; }
}

export function saveFeedback(storage: FeedbackStorage, feedback: Record<string, Feedback[]>): void {
	try { storage.setItem(feedbackKey, JSON.stringify(Object.fromEntries(Object.entries(feedback).slice(-20)))); }
	catch { /* Native notifications remain in saved Pi history. */ }
}

export function conversationFeedback(messages: CachedMessage[], feedback: Feedback[], session: string, dismissed: string[],
	range: { before?: string; after?: string } = {}): CachedMessage[] {
	const identities = new Set(messages.flatMap(message => message.feedback ? [message.feedback.id] : []));
	const saved = new Set(messages.flatMap(message => message.feedback && message.entryId ? [message.feedback.id] : []));
	const seen = new Set<string>();
	const first = messages[0]?.timestamp, last = messages.at(-1)?.timestamp;
	const result = messages.filter(message => {
		if (!message.feedback) return true;
		const item = message.feedback;
		if (!message.entryId && saved.has(item.id) || seen.has(item.id) || dismissed.includes(noticeIdentity(session, item.generation, item.id))) return false;
		seen.add(item.id); return true;
	});
	for (const item of feedback) {
		if (identities.has(item.id) || dismissed.includes(noticeIdentity(session, item.generation, item.id))) continue;
		if (range.before && first !== undefined && item.timestamp < first || range.after && last !== undefined && item.timestamp > last) continue;
		const following = messages.find(message => message.timestamp > item.timestamp);
		result.push({ id: `feedback:${item.id}`, role: "note", revision: 0, complete: true, timestamp: item.timestamp,
			order: following ? following.order - 0.0001 : (messages.at(-1)?.order ?? 0) + 0.0001,
			blocks: [{ type: "text", text: item.text }], feedback: item });
	}
	return result.sort((left, right) => left.order - right.order || left.timestamp - right.timestamp);
}
