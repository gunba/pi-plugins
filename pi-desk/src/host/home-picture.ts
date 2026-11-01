import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { homeBlob, homeConnector, homeItems, type HomeItem, type HomeScene } from "../shared/home.ts";

/** Desk's dark theme (client/tokens.css and home.css), which Jordan uses. */
const COLORS: Record<string, string> = {
	bg: "#1b1c20", text: "#e6e5e9", muted: "#96959f", accent: "#a697ef", "input-needed": "#c89aff", danger: "#ed9c9c",
	sage: "#8dbb97", amber: "#d9a54a", rose: "#e08a98", teal: "#62bdb7", sand: "#c9a97f", lilac: "#b59cf0",
};
const color = (token: unknown) => COLORS[String(token)] ?? COLORS.text!;
/** A colour blended into the background, like the canvas's color-mix(): amount 0 is the background, 1 the colour. */
function mix(token: unknown, amount: number): string {
	const channels = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
	const [from, to] = [channels(COLORS.bg!), channels(color(token))];
	return `#${from.map((value, index) => Math.round(value + (to[index]! - value) * amount).toString(16).padStart(2, "0")).join("")}`;
}
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const words = (value: unknown) => typeof value === "string" ? value : "";
/** Lines of text wrapped to a width, measured as the layout checks measure it (about 0.55 em a character). */
function wrap(text: string, size: number, width: number): string[] {
	const fits = Math.max(1, Math.floor(width / (size * 0.55))), lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (line && line.length + 1 + word.length > fits) { lines.push(line); line = word; }
		else line = line ? `${line} ${word}` : word;
	}
	return line ? [...lines, line] : lines;
}
function textLines(lines: string[], x: number, y: number, size: number, fill: string, anchor = "start", weight = 400, italic = false): string {
	return lines.map((line, index) => `<text x="${x}" y="${y + size + index * size * 1.3}" font-size="${size}" font-weight="${weight}"${italic ? ' font-style="italic"' : ""} fill="${fill}" text-anchor="${anchor}">${escape(line)}</text>`).join("");
}
/** A blob, pill or label with its icon disc, title, subtitle and status, laid out as the canvas lays it out. */
function item(item: HomeItem): string {
	const hue = item.color, parts: string[] = [], dashed = item.outline === "dashed" ? ' stroke-dasharray="5 6"' : "";
	if (item.shape === "blob") parts.push(`<path d="${homeBlob(item)}" fill="${mix(hue, 0.15)}" stroke="${mix(hue, 0.55)}" stroke-width="1.25"${dashed}/>`);
	if (item.shape === "pill") parts.push(`<rect width="${item.width}" height="${item.height}" rx="${item.height / 2}" fill="${mix(hue, 0.15)}" stroke="${mix(hue, 0.55)}" stroke-width="1.25"${dashed}/>`);
	const label = item.shape === "label", pad = label ? 8 : item.shape === "pill" ? 27 : 46, disc = label ? 28 : 40;
	const textX = pad + disc + (label ? 10 : 16), width = Math.max(40, item.width - textX - pad);
	const title = wrap(words(item.title), label ? 14 : 19, width), subtitle = wrap(words(item.subtitle), 13, width), status = words(item.status);
	const height = title.length * (label ? 14 : 19) * 1.3 + (subtitle.length ? 4 + subtitle.length * 13 * 1.4 : 0) + (status ? 10 + 16 : 0);
	let y = (item.height - height) / 2;
	parts.push(`<circle cx="${pad + disc / 2}" cy="${item.height / 2}" r="${disc / 2}" fill="${mix(hue, 0.18)}"/><circle cx="${pad + disc / 2}" cy="${item.height / 2}" r="${disc / 7}" fill="${color(hue)}"/>`);
	parts.push(textLines(title, textX, y, label ? 14 : 19, COLORS.text!, "start", 450)); y += title.length * (label ? 14 : 19) * 1.3;
	if (subtitle.length) { parts.push(textLines(subtitle, textX, y + 4, 13, COLORS.muted!)); y += 4 + subtitle.length * 13 * 1.4; }
	if (status) parts.push(`<circle cx="${textX + 3.5}" cy="${y + 10 + 9}" r="3.5" fill="${color(hue)}"/>${textLines([status], textX + 14, y + 10, 12.5, COLORS.muted!)}`);
	return `<g transform="translate(${item.x} ${item.y})">${parts.join("")}</g>`;
}
type Props = Record<string, unknown>;
function paint(props: Props, fillByDefault: boolean): string {
	const fill = props.fill ?? (fillByDefault ? props.color : "none"), width = Number(props.strokeWidth ?? 1.5);
	return `fill="${fill === "none" ? "none" : color(fill)}"${fill === "none" ? "" : ` fill-opacity="${Number(props.tint ?? 0.14)}"`}`
		+ ` stroke="${width ? color(props.color) : "none"}" stroke-width="${width}"${props.dashed ? ' stroke-dasharray="6 6"' : ""} stroke-linecap="round" stroke-linejoin="round"`;
}
/** Free drawing: text, shapes, paths and icons where the agent put them. */
function free(type: string, props: Props): string {
	const rotate = Number(props.rotate ?? 0), opacity = props.opacity === undefined ? "" : ` opacity="${Number(props.opacity)}"`;
	const open = `<g transform="translate(${Number(props.x)} ${Number(props.y)})${rotate ? ` rotate(${rotate})` : ""}"${opacity}>`;
	if (type === "Text") {
		const size = Number(props.size), align = String(props.align ?? "start"), width = Number(props.width ?? 0), text = words(props.text) || "…";
		const lines = width ? wrap(text, size, width) : [text], x = !width ? 0 : align === "middle" ? width / 2 : align === "end" ? width : 0;
		return `${open}${textLines(lines, x, 0, size, color(props.color), align, Number(props.weight ?? 400), props.italic === true)}</g>`;
	}
	if (type === "Shape") {
		const width = Number(props.width), height = Number(props.height);
		return `${open}${props.kind === "ellipse" ? `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}" ${paint(props, true)}/>`
			: `<rect width="${width}" height="${height}" rx="${Number(props.radius ?? 0)}" ${paint(props, true)}/>`}</g>`;
	}
	if (type === "Path") return `${open}<path d="${escape(String(props.d))}" ${paint(props, false)}/></g>`;
	if (type === "Icon") { const size = Number(props.size); return `${open}<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2.4}" fill="none" stroke="${color(props.color)}" stroke-width="1.7"/></g>`; }
	return "";
}

/** The scene as an SVG drawing of everything on the canvas, framed with a margin, in Desk's dark theme. */
export function homeSvg(scene: HomeScene, box: { x: number; y: number; width: number; height: number }): string {
	const items = new Map(homeItems(scene).map(entry => [entry.id, entry]));
	const body = (scene.spec.elements[scene.spec.root]?.children ?? []).map(id => {
		const element = scene.spec.elements[id];
		if (!element) return "";
		if (items.has(id)) return element.type === "Blob" || element.type === "Pill" || element.type === "Label" ? item(items.get(id)!) : free(element.type, { ...element.props, ...items.get(id) });
		if (element.type === "Connector") {
			const a = items.get(String(element.props.from)), b = items.get(String(element.props.to));
			if (!a || !b) return "";
			const link = homeConnector(a, b, Number(element.props.bend) || 0), stroke = mix(link.color, 0.55);
			return `<path d="${link.d}" fill="none" stroke="${stroke}" stroke-width="1.5"/><circle cx="${link.start.x}" cy="${link.start.y}" r="2.6" fill="${stroke}"/><circle cx="${link.end.x}" cy="${link.end.y}" r="2.6" fill="${stroke}"/>`;
		}
		return free(element.type, element.props as Props);
	}).join("");
	const margin = 40, x = box.x - margin, y = box.y - margin, width = box.width + margin * 2, height = box.height + margin * 2;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" width="${width}" height="${height}" font-family="sans-serif">`
		+ `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${COLORS.bg}"/>${body}</svg>`;
}

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
 * The scene drawn as a PNG, so the agent arranging it can see what Jordan sees. Undefined when this computer has
 * none of the fonts above; the layout checks still apply.
 */
export async function homePicture(scene: HomeScene, box: { x: number; y: number; width: number; height: number }): Promise<string | undefined> {
	ready ??= (async () => {
		await initWasm(readFileSync(createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm")));
		const found = FONTS.find(([, regular]) => existsSync(regular));
		return found ? { family: found[0], buffers: found.slice(1).filter(path => existsSync(path)).map(path => new Uint8Array(readFileSync(path))) } : undefined;
	})();
	const fonts = await ready;
	if (!fonts) return undefined;
	const svg = homeSvg(scene, box), scale = Math.min(1, 1600 / (box.width + 80));
	const picture = new Resvg(svg, { font: { fontBuffers: fonts.buffers, loadSystemFonts: false, defaultFontFamily: fonts.family, sansSerifFamily: fonts.family }, fitTo: { mode: "zoom", value: scale } });
	return Buffer.from(picture.render().asPng()).toString("base64");
}
