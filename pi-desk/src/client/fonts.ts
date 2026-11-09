/** The device's own sans-serif font, and the fallback for every bundled one. */
const SYSTEM = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/**
 * A font for Desk's text. Bundled fonts are the Latin subset of each variable font, so they look the same on every
 * device; characters outside it come from the system font.
 */
export interface TextFont {
	id: string;
	name: string;
	/** What it is like to read, for the settings page. */
	note: string;
	family?: string;
	/** The weights the variable font covers, as a FontFace weight range. */
	weight?: string;
	normal?: string;
	italic?: string;
}

// Vite emits each file and rewrites these URLs only when they are literal.
export const TEXT_FONTS: readonly TextFont[] = [
	{ id: "system", name: "System", note: "This device's own font: Segoe UI on Windows, Roboto on Android, and usually Noto Sans on Linux." },
	{ id: "inter", name: "Inter", note: "Clear and neutral, designed for screens.",
		family: "Inter", weight: "100 900",
		normal: new URL("../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", import.meta.url).href,
		italic: new URL("../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-italic.woff2", import.meta.url).href },
	{ id: "atkinson", name: "Atkinson Hyperlegible Next", note: "From the Braille Institute: letters such as I, l and 1 are shaped so they can't be confused.",
		family: "Atkinson Hyperlegible Next", weight: "200 800",
		normal: new URL("../../node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2", import.meta.url).href,
		italic: new URL("../../node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-italic.woff2", import.meta.url).href },
	{ id: "nunito", name: "Nunito Sans", note: "Soft, rounded and friendly.",
		family: "Nunito Sans", weight: "200 900",
		normal: new URL("../../node_modules/@fontsource-variable/nunito-sans/files/nunito-sans-latin-wght-normal.woff2", import.meta.url).href,
		italic: new URL("../../node_modules/@fontsource-variable/nunito-sans/files/nunito-sans-latin-wght-italic.woff2", import.meta.url).href },
	{ id: "plex", name: "IBM Plex Sans", note: "Crisp, with a slightly technical feel.",
		family: "IBM Plex Sans", weight: "100 700",
		normal: new URL("../../node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2", import.meta.url).href,
		italic: new URL("../../node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-italic.woff2", import.meta.url).href },
	{ id: "lexend", name: "Lexend", note: "Wide letters and spacing, designed for easier reading. It has no italics.",
		family: "Lexend", weight: "100 900",
		normal: new URL("../../node_modules/@fontsource-variable/lexend/files/lexend-latin-wght-normal.woff2", import.meta.url).href },
	{ id: "literata", name: "Literata", note: "A serif designed for reading books on screens, made for Google Play Books.",
		family: "Literata", weight: "200 900",
		normal: new URL("../../node_modules/@fontsource-variable/literata/files/literata-latin-wght-normal.woff2", import.meta.url).href,
		italic: new URL("../../node_modules/@fontsource-variable/literata/files/literata-latin-wght-italic.woff2", import.meta.url).href },
	{ id: "franklin", name: "Libre Franklin", note: "The open version of Franklin Gothic, which ranked first for reading speed in a 2022 study.",
		family: "Libre Franklin", weight: "100 900",
		normal: new URL("../../node_modules/@fontsource-variable/libre-franklin/files/libre-franklin-latin-wght-normal.woff2", import.meta.url).href,
		italic: new URL("../../node_modules/@fontsource-variable/libre-franklin/files/libre-franklin-latin-wght-italic.woff2", import.meta.url).href },
];

const KEY = "pi-desk:font";
const added = new Set<string>();

/** The font chosen on this device. */
export function textFont(): TextFont {
	const id = localStorage.getItem(KEY);
	return TEXT_FONTS.find(font => font.id === id) ?? TEXT_FONTS[0]!;
}

/** Shows Desk in the font; a bundled one is fetched the first time text needs it. */
export function applyTextFont(font: TextFont): void {
	if (font.family && !added.has(font.id)) {
		added.add(font.id);
		for (const [style, url] of [["normal", font.normal], ["italic", font.italic]] as const)
			if (url) document.fonts.add(new FontFace(font.family, `url(${url}) format("woff2")`, { style, weight: font.weight, display: "swap" }));
	}
	document.documentElement.style.setProperty("--text-font", font.family ? `"${font.family}", ${SYSTEM}` : SYSTEM);
}

/** Remembers the font for this device and shows Desk in it. */
export function chooseTextFont(id: string): TextFont {
	const font = TEXT_FONTS.find(item => item.id === id) ?? TEXT_FONTS[0]!;
	localStorage.setItem(KEY, font.id);
	applyTextFont(font);
	return font;
}
