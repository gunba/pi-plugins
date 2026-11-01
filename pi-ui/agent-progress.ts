export type ProgressField = "done" | "total" | "item" | "rate" | "eta";
export type ProgressSource = { file: string; pattern?: string; format?: "jsonl"; fields?: Partial<Record<ProgressField, string>> };
export type ProgressSample = { done: number; total: number; item?: string; rate?: number; eta?: number };
export type ProgressStatus = { state: "waiting" | "live" | "complete" | "stale" | "invalid" | "unavailable"; at?: number; detail?: string };
/** Only finite, nonnegative producer counts can finish a job, including an empty 0/0 job. */
export function progressComplete(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const { done, total } = value as Record<string, unknown>;
	return typeof done === "number" && Number.isFinite(done) && done >= 0
		&& typeof total === "number" && Number.isFinite(total) && total >= 0 && done >= total;
}
const names: ProgressField[] = ["done", "total", "item", "rate", "eta"];
const unsafe = new Set(["__proto__", "prototype", "constructor"]);

/** A producer declares its own fields or literal line pattern; no executable expressions or regexes. */
export function progressParser(source: ProgressSource): (line: string) => ProgressSample | undefined {
	if (!source || typeof source.file !== "string" || !source.file || source.file.length > 4000 || Object.keys(source).some(key => !["file", "pattern", "format", "fields"].includes(key))) throw new Error("Progress needs a file path and a pattern or JSONL field mapping.");
	let extract: (line: string) => Partial<Record<ProgressField, unknown>>;
	if (source.format === "jsonl") {
		if (source.pattern !== undefined || !source.fields || !source.fields.done || !source.fields.total || Object.keys(source.fields).some(key => !names.includes(key as ProgressField))
			|| Object.values(source.fields).some(key => typeof key !== "string" || !key || key.length > 100 || unsafe.has(key))) throw new Error("JSONL progress needs safe done/total field names.");
		extract = line => {
			const value: unknown = JSON.parse(line);
			if (!value || typeof value !== "object" || Array.isArray(value)) return {};
			return Object.fromEntries(Object.entries(source.fields!).map(([field, key]) => [field, Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined]));
		};
	} else {
		if (source.format !== undefined || source.fields !== undefined || typeof source.pattern !== "string" || source.pattern.length > 300) throw new Error("Use a literal pattern such as {done}/{total} {item}.");
		const fields: ProgressField[] = [], tokens = source.pattern.split(/(\{[^{}]*\})/g);
		for (let i = 1; i < tokens.length; i += 2) {
			const field = tokens[i]!.slice(1, -1) as ProgressField;
			if (!names.includes(field) || fields.includes(field)) throw new Error("Unknown or repeated progress placeholder.");
			if (i + 2 < tokens.length && !tokens[i + 1]) throw new Error("Separate progress placeholders with literal text.");
			fields.push(field);
		}
		if (!fields.includes("done") || !fields.includes("total")) throw new Error("Progress pattern needs {done} and {total}.");
		extract = line => {
			if (!line.startsWith(tokens[0]!)) return {};
			let at = tokens[0]!.length;
			const result: Partial<Record<ProgressField, unknown>> = {};
			for (let i = 0; i < fields.length; i++) {
				const suffix = tokens[2 * i + 2]!, end = suffix ? line.indexOf(suffix, at) : line.length;
				if (end < 0) return {};
				const field = fields[i]!, value = line.slice(at, end);
				if (field !== "item" && !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) return {};
				result[field] = field === "item" ? value : Number(value); at = end + suffix.length;
			}
			return at === line.length ? result : {};
		};
	}
	return line => {
		if (!line || line.length > 16_384) return;
		try {
			const value = extract(line.replace(/\r$/, ""));
			if (typeof value.done !== "number" || !Number.isFinite(value.done) || value.done < 0 || typeof value.total !== "number" || !Number.isFinite(value.total) || value.total < 0) return;
			const sample: ProgressSample = { done: value.done, total: value.total };
			if (typeof value.item === "string") sample.item = value.item.slice(0, 1000);
			for (const key of ["rate", "eta"] as const) if (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0) sample[key] = value[key];
			return sample;
		} catch { return; }
	};
}
