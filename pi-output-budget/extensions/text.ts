export const OUTPUT_CHARS = 16_000;
export const READ_CHARS = 32_000;
export const MAX_CHARS = 128_000;

/** Offsets count UTF-16 code units, as in JS strings. Never split a surrogate pair. */
export function page(text: string, offset = 0, length = OUTPUT_CHARS) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error("Invalid character offset");
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_CHARS) throw new Error(`length must be 1..${MAX_CHARS}`);
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? "") && /[\uD800-\uDBFF]/.test(text[offset - 1] ?? "")) {
    throw new Error("Offset splits a Unicode character; use the returned next_offset");
  }
  let end = Math.min(text.length, offset + length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
  if (end === offset && end < text.length) end += 2;
  return { text: text.slice(offset, end), next_offset: end < text.length ? end : null, total_chars: text.length };
}

export type Kept = "start" | "end" | "start and end";

/**
 * At most about `length` characters of `text`, keeping its start, its end or both, with "…" where text was left
 * out. A closing "[...]" notice, which Pi's own tools add when they cut their output, is kept whole.
 */
export function cutText(text: string, keep: Kept, length: number): string {
  const notice = /\n\n\[[^\n]*\]$/.exec(text)?.[0] ?? "";
  const body = text.slice(0, text.length - notice.length), room = Math.max(0, length - notice.length - 1);
  if (body.length <= room) return text;
  const start = (count: number) => body.slice(0, /[\uD800-\uDBFF]/.test(body[count - 1] ?? "") ? count - 1 : count);
  const end = (count: number) => body.slice(body.length - count + (/[\uDC00-\uDFFF]/.test(body[body.length - count] ?? "") ? 1 : 0));
  const kept = keep === "start" ? `${start(room)}…` : keep === "end" ? `…${end(room)}`
    : `${start(Math.ceil(room / 2))}…${end(Math.floor(room / 2))}`;
  return kept + notice;
}

export function literalMatches(text: string, query: string): string {
  if (!query) throw new Error("Search query must not be empty");
  return text.split("\n").flatMap((line, index) => line.includes(query) ? [`${index + 1}: ${line}`] : []).join("\n");
}
