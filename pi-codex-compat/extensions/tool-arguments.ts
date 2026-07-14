type ApplyPatchArguments = { input: string; workdir?: string };
type ViewImageArguments = { path: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function removeKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): void {
	for (const key of keys) delete value[key];
}

export function prepareApplyPatchArguments(args: unknown): ApplyPatchArguments {
	if (typeof args === "string") return { input: args };
	if (!isRecord(args)) return args as ApplyPatchArguments;
	if (args.input !== undefined && typeof args.input !== "string") {
		throw new Error("input must be a string");
	}
	if (args.workdir !== undefined && typeof args.workdir !== "string") {
		throw new Error("workdir must be a string");
	}

	const prepared = { ...args };
	const workdir = firstString(args.workdir, args.cwd, args.working_directory);
	if (workdir !== undefined) {
		prepared.workdir = workdir;
		removeKeys(prepared, ["cwd", "working_directory"]);
	}

	const command = args.command;
	if (Array.isArray(command)) {
		const commandName = command[0];
		const body = command[1];
		if (
			(commandName === "apply_patch" || commandName === "applypatch") &&
			command.length === 2 &&
			typeof body === "string"
		) {
			prepared.input = body;
			removeKeys(prepared, ["command", "patch", "body", "text"]);
			return prepared as ApplyPatchArguments;
		}
	}

	const input = firstString(args.input, args.patch, args.body, args.text);
	if (input !== undefined) {
		prepared.input = input;
		removeKeys(prepared, ["patch", "body", "text"]);
	}
	return prepared as ApplyPatchArguments;
}

export function prepareViewImageArguments(args: unknown): ViewImageArguments {
	if (!isRecord(args)) return args as ViewImageArguments;
	if (args.path !== undefined && typeof args.path !== "string") {
		throw new Error("path must be a string");
	}
	const prepared = { ...args };
	const path = firstString(args.path, args.file_path, args.image_path);
	if (path !== undefined) {
		prepared.path = path;
		removeKeys(prepared, ["file_path", "image_path"]);
	}
	return prepared as ViewImageArguments;
}
