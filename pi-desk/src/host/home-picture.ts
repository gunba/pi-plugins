import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

/** Sans-serif fonts found on Linux, Windows and macOS, with their bold faces; the picture uses the first that exists. */
const FONTS: [string, string, string][] = [
	["DejaVu Sans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
	["DejaVu Sans", "/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"],
	["Noto Sans", "/usr/share/fonts/noto/NotoSans-Regular.ttf", "/usr/share/fonts/noto/NotoSans-Bold.ttf"],
	["Noto Sans", "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"],
	["Segoe UI", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/segoeuib.ttf"],
	["Arial", "/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"],
];
let ready: Promise<{ family: string; buffers: Uint8Array[] } | undefined> | undefined;
/**
 * The canvas's SVG drawn as a PNG 1400 pixels wide, so the agent drawing it can see what Jordan sees. Undefined when
 * this computer has none of the fonts above.
 */
export async function homePicture(svg: string): Promise<string | undefined> {
	ready ??= (async () => {
		await initWasm(readFileSync(createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm")));
		const found = FONTS.find(([, regular]) => existsSync(regular));
		return found ? { family: found[0], buffers: found.slice(1).filter(path => existsSync(path)).map(path => new Uint8Array(readFileSync(path))) } : undefined;
	})();
	const fonts = await ready;
	if (!fonts || !svg) return undefined;
	const picture = new Resvg(svg, { font: { fontBuffers: fonts.buffers, loadSystemFonts: false, defaultFontFamily: fonts.family, sansSerifFamily: fonts.family },
		fitTo: { mode: "width", value: 1400 } });
	return Buffer.from(picture.render().asPng()).toString("base64");
}
