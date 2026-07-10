type ApplyPatchArguments = { input: string; workdir?: string };
type ShellCommandArguments = {
	command: string;
	workdir?: string;
	shell?: string;
	timeout_ms?: number;
	timeout?: number;
	login?: boolean;
	yield_time_ms?: number;
	max_output_tokens?: number;
};
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

export function prepareApplyPatchArguments(args: unknown): ApplyPatchArguments {
	if (typeof args === "string") return { input: args };
	if (!isRecord(args)) return args as ApplyPatchArguments;
	const workdir = firstString(args.workdir, args.cwd, args.working_directory);

	const command = args.command;
	if (Array.isArray(command)) {
		const commandName = command[0];
		const body = command[1];
		if (
			(commandName === "apply_patch" || commandName === "applypatch") &&
			typeof body === "string"
		) {
			return { input: body, workdir };
		}
	}

	const input = firstString(args.input, args.patch, args.body, args.text);
	if (input !== undefined) return { input, workdir };
	return args as ApplyPatchArguments;
}

export function prepareShellCommandArguments(args: unknown): ShellCommandArguments {
	if (typeof args === "string") return { command: args };
	if (!isRecord(args)) return args as ShellCommandArguments;
	const command = firstString(args.command, args.cmd, args.script);
	return command === undefined
		? (args as ShellCommandArguments)
		: ({
				...args,
				command,
				workdir: firstString(args.workdir, args.cwd, args.working_directory),
			} as ShellCommandArguments);
}

export function prepareViewImageArguments(args: unknown): ViewImageArguments {
	if (!isRecord(args)) return args as ViewImageArguments;
	const path = firstString(args.path, args.file_path, args.image_path);
	return path === undefined ? (args as ViewImageArguments) : { path };
}
