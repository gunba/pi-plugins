export type ShellApplyPatchInvocation = {
	input: string;
	workdir?: string;
};

type ShellOperator = "&&" | "<<" | "<<-";
type ShellToken =
	| { kind: "word"; value: string }
	| { kind: "operator"; value: ShellOperator };

function isHorizontalWhitespace(character: string): boolean {
	return character === " " || character === "\t";
}

function isShellMetacharacter(character: string): boolean {
	return (
		character === "&" ||
		character === "|" ||
		character === ";" ||
		character === "<" ||
		character === ">" ||
		character === "(" ||
		character === ")"
	);
}

function shellOperatorAt(
	input: string,
	index: number,
): ShellOperator | undefined {
	if (input.startsWith("<<-", index)) return "<<-";
	if (input.startsWith("&&", index)) return "&&";
	if (input.startsWith("<<", index)) return "<<";
	return undefined;
}

function readSingleQuotedWord(
	input: string,
	start: number,
): { value: string; next: number } | undefined {
	let value = "";
	for (let index = start + 1; index < input.length; index++) {
		const character = input[index];
		if (character === "'") return { value, next: index + 1 };
		value += character;
	}
	return undefined;
}

function readDoubleQuotedWord(
	input: string,
	start: number,
): { value: string; next: number } | undefined {
	let value = "";
	for (let index = start + 1; index < input.length; index++) {
		const character = input[index];
		if (character === '"') return { value, next: index + 1 };
		if (character === "`" || character === "$") return undefined;
		if (character === "\\") {
			const escaped = input[index + 1];
			if (escaped === undefined) return undefined;
			if (
				escaped === '"' ||
				escaped === "\\" ||
				escaped === "$" ||
				escaped === "`"
			) {
				value += escaped;
				index += 1;
				continue;
			}
			value += `\\${escaped}`;
			index += 1;
			continue;
		}
		value += character;
	}
	return undefined;
}

function tokenizeShellHeader(input: string): ShellToken[] | undefined {
	const tokens: ShellToken[] = [];
	let index = 0;

	while (index < input.length) {
		while (index < input.length && isHorizontalWhitespace(input[index]))
			index += 1;
		if (index === input.length) break;

		const operator = shellOperatorAt(input, index);
		if (operator) {
			tokens.push({ kind: "operator", value: operator });
			index += operator.length;
			continue;
		}
		if (isShellMetacharacter(input[index])) return undefined;

		let value = "";
		let consumed = false;
		while (index < input.length) {
			const character = input[index];
			if (isHorizontalWhitespace(character) || shellOperatorAt(input, index))
				break;
			if (
				isShellMetacharacter(character) ||
				character === "`" ||
				character === "$"
			) {
				return undefined;
			}
			if (character === "'") {
				const quoted = readSingleQuotedWord(input, index);
				if (!quoted) return undefined;
				value += quoted.value;
				index = quoted.next;
				consumed = true;
				continue;
			}
			if (character === '"') {
				const quoted = readDoubleQuotedWord(input, index);
				if (!quoted) return undefined;
				value += quoted.value;
				index = quoted.next;
				consumed = true;
				continue;
			}
			if (character === "\\") {
				const escaped = input[index + 1];
				if (escaped === undefined) return undefined;
				value += escaped;
				index += 2;
				consumed = true;
				continue;
			}
			if (
				character === "*" ||
				character === "?" ||
				character === "[" ||
				character === "{" ||
				character === "}" ||
				(character === "~" && value.length === 0)
			) {
				return undefined;
			}
			value += character;
			index += 1;
			consumed = true;
		}
		if (!consumed) return undefined;
		tokens.push({ kind: "word", value });
	}

	return tokens;
}

function word(
	token: ShellToken | undefined,
	value?: string,
): string | undefined {
	if (token?.kind !== "word") return undefined;
	if (value !== undefined && token.value !== value) return undefined;
	return token.value;
}

function operator(
	token: ShellToken | undefined,
	...values: ShellOperator[]
): ShellOperator | undefined {
	return token?.kind === "operator" && values.includes(token.value)
		? token.value
		: undefined;
}

function isApplyPatchCommand(value: string | undefined): boolean {
	return value === "apply_patch" || value === "applypatch";
}

function removeOneTrailingCarriageReturn(value: string): string {
	return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function removeLeadingTabs(value: string): string {
	let index = 0;
	while (value[index] === "\t") index += 1;
	return value.slice(index);
}

function isBlank(value: string): boolean {
	for (const character of value) {
		if (!isHorizontalWhitespace(character) && character !== "\n") return false;
	}
	return true;
}

function removeLeadingBlankLines(value: string): string {
	let start = 0;
	while (start < value.length) {
		const lineEnd = value.indexOf("\n", start);
		if (lineEnd < 0 || !isBlank(value.slice(start, lineEnd))) break;
		start = lineEnd + 1;
	}
	return value.slice(start);
}

function extractHeredocBody(
	body: string,
	delimiter: string,
	stripTabs: boolean,
): string | undefined {
	if (!delimiter) return undefined;
	const lines = body.split("\n").map(removeOneTrailingCarriageReturn);
	for (let index = 0; index < lines.length; index++) {
		const candidate = stripTabs
			? removeLeadingTabs(lines[index])
			: lines[index];
		if (candidate !== delimiter) continue;
		if (lines.slice(index + 1).some((line) => !isBlank(line))) return undefined;
		const patchLines = lines.slice(0, index);
		return (stripTabs ? patchLines.map(removeLeadingTabs) : patchLines).join(
			"\n",
		);
	}
	return undefined;
}

/**
 * Recognize the complete shell forms that Codex routes to apply_patch.
 *
 * This intentionally parses a small shell grammar instead of pattern-matching
 * command text: an optional `cd <one word> &&`, one apply_patch/applypatch
 * command, and one heredoc redirection. Any expansion, extra argument,
 * connector, redirect, or command leaves the script to the normal shell.
 */
export function extractShellApplyPatch(
	command: string,
): ShellApplyPatchInvocation | undefined {
	if (command.includes("\r")) return undefined;
	const source = removeLeadingBlankLines(command);
	const headerEnd = source.indexOf("\n");
	if (headerEnd < 0) return undefined;
	const header = removeOneTrailingCarriageReturn(source.slice(0, headerEnd));
	const tokens = tokenizeShellHeader(header);
	if (!tokens) return undefined;

	let cursor = 0;
	let workdir: string | undefined;
	if (word(tokens[cursor], "cd") !== undefined) {
		workdir = word(tokens[cursor + 1]);
		if (
			!workdir ||
			workdir.startsWith("-") ||
			operator(tokens[cursor + 2], "&&") !== "&&"
		) {
			return undefined;
		}
		cursor += 3;
	}

	const commandName = word(tokens[cursor]);
	if (!isApplyPatchCommand(commandName)) return undefined;
	const heredoc = operator(tokens[cursor + 1], "<<", "<<-");
	const delimiter = word(tokens[cursor + 2]);
	if (!heredoc || !delimiter || cursor + 3 !== tokens.length) return undefined;

	const input = extractHeredocBody(
		source.slice(headerEnd + 1),
		delimiter,
		heredoc === "<<-",
	);
	return input === undefined ? undefined : { input, workdir };
}
