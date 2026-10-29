/**
 * Dates and numbers in the browser's locale, with each formatter built once. Date's toLocale*String builds a new Intl
 * formatter on every call, which made formatting the largest single cost of re-rendering the sidebar and transcript
 * while agents stream. Each function returns what the toLocale*String call it names returns.
 */
// toLocaleString() with no options shows every field as numeric.
const ALL: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" };
export const HOUR_MINUTE: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
const numbers = new Intl.NumberFormat();
const formats = new Map<string, Intl.DateTimeFormat>();
function format(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = JSON.stringify(options);
	let found = formats.get(key);
	if (!found) formats.set(key, found = new Intl.DateTimeFormat(undefined, options));
	return found;
}
/** Date#toLocaleString(); the options must name the fields to show, as toLocaleString's do. */
export const localDateTime = (at: number | Date, options: Intl.DateTimeFormatOptions = ALL) => format(options).format(at);
/** Date#toLocaleTimeString with options that name time fields. */
export const localTime = (at: number | Date, options: Intl.DateTimeFormatOptions) => format(options).format(at);
/** Date#toLocaleDateString with options that name date fields. */
export const localDate = (at: number | Date, options: Intl.DateTimeFormatOptions) => format(options).format(at);
/** Number#toLocaleString(). */
export const localNumber = (value: number) => numbers.format(value);
