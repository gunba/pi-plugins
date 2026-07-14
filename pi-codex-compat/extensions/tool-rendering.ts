type ApplyPatchRenderArgs = { input?: unknown; workdir?: unknown };
type ExecCommandRenderArgs = {
	cmd?: unknown;
	workdir?: unknown;
	shell?: unknown;
	login?: unknown;
	tty?: unknown;
	yield_time_ms?: unknown;
};
type WriteStdinRenderArgs = { session_id?: unknown; chars?: unknown };

type ExecResultDetails = {
	session_id?: number;
	exit_code?: number;
	signal?: string;
	running?: boolean;
	aborted?: boolean;
	truncated?: boolean;
	full_output_path?: string;
	fullOutputPath?: string;
	error?: string;
};

type ApplyPatchResultDetails = {
	changes?: Array<{ action?: string; path?: string; movePath?: string }>;
	error?: string;
};

const MAX_CALL_TEXT = 140;

function compactText(value: unknown, maxLength = MAX_CALL_TEXT): string {
	if (typeof value !== "string") return "";
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLength) return oneLine;
	return `${oneLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function displayWorkdir(value: unknown): string {
	const workdir = compactText(value, 50);
	return workdir ? ` in ${workdir}` : "";
}

export function formatExecCommandCall(args: ExecCommandRenderArgs): string {
	const command = compactText(args.cmd) || "…";
	const options: string[] = [];
	if (typeof args.shell === "string" && args.shell.trim()) {
		options.push(compactText(args.shell, 35));
	}
	if (args.login === true) options.push("login");
	if (args.tty === true) options.push("tty");
	if (typeof args.yield_time_ms === "number") {
		options.push(`yield ${args.yield_time_ms}ms`);
	}
	const suffix = options.length ? ` · ${options.join(", ")}` : "";
	return `$ ${command}${displayWorkdir(args.workdir)}${suffix}`;
}

function visibleInput(value: string): string {
	return value
		.split("\u0003")
		.join("^C")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t");
}

export function formatWriteStdinCall(args: WriteStdinRenderArgs): string {
	const session =
		typeof args.session_id === "number" ? `#${args.session_id}` : "#?";
	if (args.chars === undefined || args.chars === "") {
		return `write_stdin ${session} · poll`;
	}
	if (typeof args.chars !== "string") return `write_stdin ${session}`;
	return `write_stdin ${session} · send "${compactText(visibleInput(args.chars), 70)}"`;
}

export function formatApplyPatchCall(args: ApplyPatchRenderArgs): string {
	const input = typeof args.input === "string" ? args.input : "";
	const paths = [
		...input.matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm),
	].flatMap((match) => {
		const path = match[1]?.trim();
		return path ? [path] : [];
	});
	const uniquePaths = [...new Set(paths)];
	let target = `${uniquePaths.length} files`;
	if (uniquePaths.length === 0) target = "patch";
	if (uniquePaths.length === 1) target = compactText(uniquePaths[0], 80);
	return `apply_patch ${target}${displayWorkdir(args.workdir)}`;
}

export function resultText(result: { content?: unknown }): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.flatMap((item) => {
			if (
				typeof item !== "object" ||
				item === null ||
				(item as { type?: unknown }).type !== "text" ||
				typeof (item as { text?: unknown }).text !== "string"
			) {
				return [];
			}
			return [(item as { text: string }).text];
		})
		.join("\n");
}

export function liveOutputPreview(text: string, maxLines = 4): string {
	const lines = text.trimEnd().split("\n");
	const outputIndex = lines.indexOf("Output:");
	const outputLines = outputIndex >= 0 ? lines.slice(outputIndex + 1) : lines;
	return outputLines.slice(-maxLines).join("\n").trim() || "Running…";
}

export function summarizeExecResult(details: unknown): string {
	const value = (details ?? {}) as ExecResultDetails;
	const savedPath = value.full_output_path ?? value.fullOutputPath;
	let summary: string;
	if (value.aborted) summary = "Aborted";
	else if (value.error) summary = "Failed";
	else if (value.running) {
		summary = value.session_id
			? `Session #${value.session_id} running`
			: "Process running";
	} else if (value.exit_code !== undefined) {
		summary = value.exit_code === 0 ? "Completed" : `Exited ${value.exit_code}`;
	} else if (value.signal) {
		summary = `Exited with ${value.signal}`;
	} else {
		summary = "Completed";
	}
	if (savedPath) summary += " · output saved";
	else if (value.truncated) summary += " · output truncated";
	return summary;
}

export function summarizeApplyPatchResult(details: unknown): string {
	const value = (details ?? {}) as ApplyPatchResultDetails;
	if (value.error) return "Patch failed";
	const count = Array.isArray(value.changes) ? value.changes.length : 0;
	if (count === 0) return "Patch applied";
	return `Patched ${count} ${count === 1 ? "file" : "files"}`;
}
