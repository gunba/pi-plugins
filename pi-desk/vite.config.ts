import { defineConfig, type Plugin } from "vite";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/**
 * "virtual:office-frame/docx" (or pptx, xlsx): the script that draws that kind of Office file inside Desk's sandboxed
 * page, as text. The sandbox has an opaque origin and loads nothing, so its script is bundled whole here and written
 * into the frame (client/office-pages.tsx). Each kind is its own chunk, loaded when a file of that kind is shown.
 */
function officeFrames(): Plugin {
	const prefix = "virtual:office-frame/";
	return {
		name: "office-frames",
		resolveId: id => id.startsWith(prefix) ? "\0" + id : undefined,
		async load(id) {
			if (!id.startsWith("\0" + prefix)) return;
			const kind = id.slice(prefix.length + 1);
			if (!["docx", "pptx", "xlsx"].includes(kind)) throw new Error(`No Office frame for ${kind}.`);
			const entry = fileURLToPath(new URL(`./src/office-frame/${kind}.ts`, import.meta.url));
			const result = await build({ entryPoints: [entry], bundle: true, format: "iife", minify: true, write: false, target: "es2022",
				legalComments: "eof", define: { "process.env.NODE_ENV": '"production"' }, metafile: true });
			for (const input of Object.keys(result.metafile.inputs)) this.addWatchFile(input);
			// Written inside a script element, so no "</script" may end it early.
			return `export default ${JSON.stringify(result.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script"))};`;
		},
	};
}

export default defineConfig({
	plugins: [officeFrames()],
	build: {
		rollupOptions: {
			input: {
				app: fileURLToPath(new URL("./index.html", import.meta.url)),
			},
		},
	},
});
