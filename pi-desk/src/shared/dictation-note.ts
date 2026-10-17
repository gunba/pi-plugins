/**
 * The line Desk adds to a message that includes dictated text, so the agent reads past speech-recognition
 * errors instead of taking them literally. Desk shows it as a badge; the model sees it as text.
 */
export const DICTATION_NOTE = "(Dictated: speech recognition may have misheard some words.)";

export function withDictationNote(text: string): string {
	const trimmed = text.replace(/\s+$/, "");
	return trimmed.endsWith(DICTATION_NOTE) ? trimmed : `${trimmed}\n\n${DICTATION_NOTE}`;
}

/** A message's text without the note, and whether it had one. */
export function splitDictationNote(text: string): { text: string; dictated: boolean } {
	const trimmed = text.replace(/\s+$/, "");
	return trimmed.endsWith(DICTATION_NOTE) ? { text: trimmed.slice(0, -DICTATION_NOTE.length).replace(/\s+$/, ""), dictated: true } : { text, dictated: false };
}
