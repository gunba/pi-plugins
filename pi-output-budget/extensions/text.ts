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

export function literalMatches(text: string, query: string): string {
  if (!query) throw new Error("Search query must not be empty");
  return text.split("\n").flatMap((line, index) => line.includes(query) ? [`${index + 1}: ${line}`] : []).join("\n");
}
