export type Dialect = "posix" | "powershell" | "cmd";
export type Word = { text: string; dynamic: boolean; operator?: boolean };
export type Syntax = { words: Word[]; uncertain: boolean; substitutions: string[] };

function substitution(source: string, start: number, delimiter: "paren" | "tick", dialect: Dialect): { body: string; end: number } | undefined {
	let nesting = 1, quote = "";
	for (let i = start; i < source.length; i++) {
		const c = source[i];
		if (c === (dialect === "powershell" ? "`" : "\\") && i + 1 < source.length) { i++; continue; }
		if (delimiter === "tick") { if (c === "`") return { body: source.slice(start, i), end: i }; continue; }
		if (quote) { if (c === quote) quote = ""; continue; }
		if (c === "'" || c === '"') { quote = c; continue; }
		if (c === "(") nesting++;
		if (c === ")" && --nesting === 0) return { body: source.slice(start, i), end: i };
	}
	return undefined;
}

/** A command-word lexer, not a shell interpreter. Expansions remain unresolved. */
export function lex(source: string, dialect: Dialect): Syntax {
	const words: Word[] = [], substitutions: string[] = [];
	let text = "", dynamic = false, started = false, quote = "", uncertain = false;
	const emit = () => { if (started) words.push({ text, dynamic }); text = ""; dynamic = false; started = false; };
	for (let i = 0; i < source.length; i++) {
		const c = source[i], next = source[i + 1];
		if (dialect !== "cmd" && quote !== "'" && (c === "$" && next === "(" || dialect === "posix" && ((!quote && /[<>]/.test(c) && next === "(") || c === "`"))) {
			const nested = substitution(source, i + (c === "`" ? 1 : 2), c === "`" ? "tick" : "paren", dialect);
			if (nested) { substitutions.push(nested.body); text += "$SUBSTITUTION"; dynamic = started = true; i = nested.end; continue; }
			uncertain = true;
		}
		if (quote) {
			if (c === quote) {
				if (dialect === "powershell" && next === quote) { text += c; i++; } else quote = "";
			} else if ((dialect === "posix" && quote === '"' && c === "\\" && next && /[$`"\\\n]/.test(next)) || (dialect === "powershell" && quote === '"' && c === "`" && next)) {
				if (next !== "\n") text += next; i++;
			} else {
				text += c;
				if (quote === '"' && (c === "$" || c === "`") || dialect === "cmd" && (c === "%" || c === "!")) dynamic = true;
			}
			continue;
		}
		if (c === "'" && dialect !== "cmd" || c === '"') { started = true; quote = c; continue; }
		if ((dialect === "posix" && c === "\\" || dialect === "powershell" && c === "`" || dialect === "cmd" && c === "^") && next) {
			started = true; if (next !== "\n") text += next; i++; continue;
		}
		if (c === "#" && !started && dialect !== "cmd") { while (i < source.length && source[i] !== "\n") i++; emit(); words.push({ text: ";", dynamic: false, operator: true }); continue; }
		if (/\s/.test(c)) { emit(); if (c === "\n") words.push({ text: ";", dynamic: false, operator: true }); continue; }
		if (/[;&|<>{}()]/.test(c) || dialect === "powershell" && c === ",") {
			emit(); let op = c;
			if (next === c && /[&|<>]/.test(c) || next === "&" && /[<>]/.test(c)) { op += next; i++; }
			if (op === "<<") uncertain = true;
			words.push({ text: op, dynamic: false, operator: true }); continue;
		}
		started = true; text += c;
		if (c === "$" || c === "`" || dialect === "cmd" && (c === "%" || c === "!")) dynamic = true;
		if (c === "`") uncertain = true;
	}
	emit();
	return { words, uncertain: uncertain || !!quote, substitutions };
}

export function commandName(word: string): string {
	return word.replaceAll("\\", "/").split("/").at(-1)!.toLowerCase().replace(/\.exe$/, "");
}

/** Strip string/comment bodies when looking for calls in an inline program. */
export function programTokens(source: string): { text: string; string?: boolean }[] {
	const result: { text: string; string?: boolean }[] = [];
	for (let i = 0; i < source.length;) {
		const c = source[i];
		if (/\s/.test(c)) { i++; continue; }
		if (c === "#" || source.slice(i, i + 2) === "//") { while (i < source.length && source[i] !== "\n") i++; continue; }
		if (source.slice(i, i + 2) === "/*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; continue; }
		if (c === '"' || c === "'" || c === "`") {
			const triple = source.slice(i, i + 3) === c.repeat(3), delimiter = triple ? c.repeat(3) : c;
			i += delimiter.length; let text = "";
			while (i < source.length && source.slice(i, i + delimiter.length) !== delimiter) {
				if (source[i] === "\\" && i + 1 < source.length) {
					const next = source[++i]; text += next === "\\" || next === c ? next : `\\${next}`; i++;
				} else text += source[i++];
			}
			i += delimiter.length; result.push({ text, string: true }); continue;
		}
		const name = source.slice(i).match(/^[\w$]+/);
		if (name) { result.push({ text: name[0] }); i += name[0].length; }
		else { result.push({ text: c }); i++; }
	}
	return result;
}
