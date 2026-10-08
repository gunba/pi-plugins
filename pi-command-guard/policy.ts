import { lex, commandName, programTokens, type Dialect, type Word } from "./syntax.ts";
import { block, confirm, pathFinding, type Environment, type Finding } from "./paths.ts";
export type Assessment = { decision: "pass" } | Finding;
const MAX_COMMAND = 16_384;
const choose = (findings: (Finding | undefined)[]): Assessment => findings.find(item => item?.decision === "block") ?? findings.find(Boolean) ?? { decision: "pass" };
const finding = (result: Assessment): Finding | undefined => result.decision === "pass" ? undefined : result;
const separators = new Set([";", "&&", "||", "|", "&", "{", "}"]);
const interpreters = /^(?:python(?:\d+(?:\.\d+)*)?|py|node|nodejs|ruby|perl)$/;
const shells = /^(?:bash|sh|zsh|dash|ksh|fish|powershell|pwsh|cmd)$/;
export const dialectFor = (shell: string): Dialect => /^(?:powershell|pwsh)$/.test(commandName(shell)) ? "powershell" : commandName(shell) === "cmd" ? "cmd" : "posix";

function program(source: string, env: Environment): Assessment {
	const tokens = programTokens(source), hits: (Finding | undefined)[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]; if (token.string || tokens[i + 1]?.text !== "(") continue;
		const name = token.text.toLowerCase(), owner = tokens.slice(Math.max(0, i - 6), i).map(part => part.text).join("").toLowerCase();
		if (/^(?:rmtree|rm_rf|remove_tree|rmsync|rmdirsync|unlinksync|unlink|rmdir)$/.test(name) || /^(?:rm|remove|delete)$/.test(name) && /(?:fs|shutil|os|path|directory|file|deno)(?:\.|\.promises\.)$/.test(owner)) {
			const first = tokens[i + 2], value = first?.string ? first.text : undefined;
			if (value) hits.push(pathFinding(value, env, { deletion: true, recursive: /rmtree|rm|delete/.test(name) }));
			hits.push(confirm("inline-deletion", "An inline program contains a recognized filesystem deletion call."));
		}
		if (/^(?:eval|exec|execsync|execfile|execfilesync|spawn|spawnsync|system|popen|function|compile)$/.test(name)) hits.push(confirm("inline-execution", "An inline program evaluates code or starts another command."));
	}
	return choose(hits);
}

export function assessCommand(source: string, env: Environment, dialect: Dialect = "posix", depth = 0): Assessment {
	if (source.length > MAX_COMMAND) return block("command-size", "The command is too large for bounded review; no command was run.");
	if (depth > 4) return confirm("nested-shell", "The command has more nested execution layers than this guard interprets.");
	if (source.includes("\0")) return block("invalid-command", "The command contains a null character.");
	// Only a complete single heredoc is treated as literal input. Other forms need review.
	const here = source.match(/^([^\n]*?)\s<<(-?)(['"]?)([A-Za-z_]\w*)\3[^\n]*\n/);
	if (here) {
		const rest = source.slice(here[0].length), lines = rest.split("\n");
		const end = lines.findIndex(line => (here[2] ? line.replace(/^\t+/, "") : line) === here[4]);
		if (end < 0) return confirm("heredoc", "The heredoc boundary could not be resolved.");
		const body = lines.slice(0, end).join("\n"), head = lex(here[1], dialect).words;
		const name = commandName(head[0]?.text ?? ""), tail = lines.slice(end + 1).join("\n");
		const hits = [finding(assessCommand(here[1], env, dialect, depth + 1)), finding(assessCommand(tail, env, dialect, depth + 1))];
		if (!here[3] && /[$`]/.test(body) || /[|<>]/.test(source.slice(here[1].length, here[0].length).replace(/<<-?['"]?\w+['"]?/, ""))) hits.push(confirm("heredoc-expansion", "The heredoc includes shell expansion or additional redirection."));
		if (interpreters.test(name)) hits.push(finding(program(body, env)));
		else if (shells.test(name)) hits.push(finding(assessCommand(body, env, dialectFor(name), depth + 1)));
		else if (name !== "cat") hits.push(confirm("heredoc-program", "A program receives inline input that this guard does not interpret."));
		return choose(hits);
	}
	const parsed = lex(source, dialect), hits: (Finding | undefined)[] = [];
	if (parsed.uncertain) hits.push(confirm("shell-syntax", "Shell quoting, substitution or heredoc syntax needs review."));
	for (const body of parsed.substitutions) hits.push(finding(assessCommand(body, env, dialect, depth + 1)));
	let segment: Word[] = [], cwdChanged = false, piped = false;
	const check = () => {
		if (!segment.length) return;
		const result = command(segment, env, dialect, depth, cwdChanged, piped); hits.push(...result);
		if (segment.some(word => /^(?:cd|pushd|set-location|sl)$/i.test(word.text))) cwdChanged = true;
		segment = [];
	};
	for (let i = 0; i < parsed.words.length; i++) {
		const word = parsed.words[i];
		if (word.operator && separators.has(word.text)) { check(); piped = word.text === "|"; }
		else if (word.operator && [">&", "<&"].includes(word.text)) {
			const target = parsed.words[++i];
			if (!target || !/^(?:\d+|-)$/.test(target.text)) hits.push(confirm("redirection", "The file-descriptor redirection is unresolved."));
		} else if (word.operator && (word.text === ">" || word.text === ">>")) {
			const target = parsed.words[++i];
			if (!target || target.operator) hits.push(confirm("redirection", "An output redirection target is unresolved."));
			else if (!/^(?:\/dev\/(?:null|stdout|stderr)|nul|&\d)$/i.test(target.text)) hits.push(pathFinding(target.text, env, { dynamic: target.dynamic, cwdChanged }));
		} else segment.push(word);
	}
	check(); return choose(hits);
}

function command(words: Word[], env: Environment, dialect: Dialect, depth: number, cwdChanged: boolean, piped: boolean): (Finding | undefined)[] {
	if (depth > 4) return [confirm("nested-shell", "The command has more nested execution layers than this guard interprets.")];
	words = words.filter(word => !word.operator || !["(", ")", ","].includes(word.text));
	while (words[0] && /^[A-Za-z_]\w*=/.test(words[0].text)) words.shift();
	if (!words.length) return [];
	const name = commandName(words[0].text), args = words.slice(1);
	if (/^\[(?:system\.)?io\.(?:directory|file)\]::delete$/i.test(name)) {
		const target = args.find(word => !word.operator);
		return [target && pathFinding(target.text, env, { deletion: true, recursive: true, dynamic: target.dynamic, cwdChanged }), confirm("inline-deletion", "A .NET filesystem deletion is requested.")];
	}
	if (["eval", "invoke-expression", "iex"].includes(name)) {
		const body = args.filter(word => word.text.toLowerCase() !== "-command");
		return [body.some(word => word.dynamic) ? undefined : finding(assessCommand(body.map(word => word.text).join(" "), env, dialect, depth + 1)), confirm("evaluation", "The command evaluates another command string.")];
	}
	if (words[0].dynamic) return [confirm("dynamic-command", "The executable name contains an unresolved expansion.")];
	if (["sudo", "env", "command", "nohup", "nice", "timeout"].includes(name)) {
		const parameters: Record<string, string[]> = {
			sudo: ["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-D", "--chdir", "-R", "--chroot", "-C", "--close-from", "-T", "--command-timeout"],
			env: ["-u", "--unset", "-C", "--chdir", "-a", "--argv0", "-S", "--split-string"],
			nice: ["-n", "--adjustment"], timeout: ["-s", "--signal", "-k", "--kill-after"],
		};
		let index = 0;
		while (index < args.length && (args[index].text.startsWith("-") || /^[A-Za-z_]\w*=/.test(args[index].text))) {
			const option = args[index++].text;
			if (parameters[name]?.includes(option)) index++;
		}
		if (name === "timeout") index++;
		if (index >= args.length) return [confirm("wrapper", "The wrapped command could not be resolved.")];
		if (depth >= 4) return [confirm("wrapper", "The command has too many execution wrappers.")];
		return command(args.slice(index), env, dialect, depth + 1, cwdChanged || name === "env", piped);
	}
	if (shells.test(name)) {
		const encoded = args.findIndex(word => /^-(?:e|enc|encodedcommand)$/i.test(word.text));
		if (encoded >= 0) return [confirm("encoded-command", "An encoded command requires review in decoded form.")];
		const at = args.findIndex(word => /^(?:-[a-z]*c|--command|\/c|\/k)$/i.test(word.text));
		if (at >= 0) {
			const body = args[at + 1];
			if (!body || body.dynamic) return [confirm("shell-command", "The nested shell command is unresolved.")];
			return [finding(assessCommand(body.text, env, dialectFor(name), depth + 1)),
				...(["cmd", "pwsh", "powershell"].includes(name) && args.length > at + 2
					? command(args.slice(at + 1), env, dialectFor(name), depth + 1, cwdChanged, false) : [])];
		}
		const ps = args.findIndex(word => /^-command$/i.test(word.text));
		if (ps >= 0) return [finding(assessCommand(args.slice(ps + 1).map(word => word.text).join(" "), env, "powershell", depth + 1))];
		if (piped || !args.length || args.some(word => word.text === "-")) return [confirm("shell-input", "A shell receives commands from unresolved input.")];
		return [];
	}
	if (interpreters.test(name)) {
		const at = args.findIndex(word => /^(?:-[cep]|--eval|--print)$/i.test(word.text));
		const attached = args.map(word => word.text.match(/^(?:-[cep]|--(?:eval|print)=)(.+)$/s)).find(Boolean)?.[1];
		if (at >= 0 || attached !== undefined) {
			const body = attached ?? args[at + 1]?.text;
			return [body ? finding(program(body, env)) : confirm("inline-code", "The inline program is missing.")];
		}
		return piped ? [confirm("interpreter-input", "An interpreter receives executable input from a pipeline.")] : [];
	}
	const values = args.map(word => word.text), lower = values.map(value => value.toLowerCase());
	if (/^(?:mkfs(?:\..+)?|format|format-volume|clear-disk|initialize-disk|remove-partition|diskpart|wipefs)$/.test(name)) return [block("disk-destruction", "Disk formatting, partition removal or filesystem destruction is not admitted by this guard.")];
	if (name === "dd") {
		const output = args.find(word => word.text.startsWith("of="));
		return output ? [pathFinding(output.text.slice(3), env, { dynamic: output.dynamic }), confirm("raw-copy", "A block-copy command will overwrite its output.")] : [];
	}
	const deletion = /^(?:rm|rmdir|rd|del|erase|remove-item|ri|unlink|shred|wipe)$/.test(name);
	if (deletion) {
		const recursive = lower.some(value => /^(?:--recursive|-recurse(?:[:=]true)?|\/s)$/.test(value) || /^-[a-z]*r[a-z]*$/i.test(value));
		const targets = args.filter(word => !word.operator && word.text !== "--" && !word.text.startsWith("-") && !(dialect === "cmd" && /^\/[a-z]+$/i.test(word.text)) && word.text !== "@");
		return targets.length ? targets.map(target => pathFinding(target.text, env, { deletion: true, recursive: recursive || /shred|wipe/.test(name), dynamic: target.dynamic, cwdChanged }))
			: [confirm("deletion-input", "Deletion targets come from unresolved input.")];
	}
	if (["mv", "move", "move-item", "cp", "copy", "copy-item", "truncate", "clear-content", "set-content", "out-file"].includes(name)) {
		const targets = args.filter(word => !word.operator && !word.text.startsWith("-"));
		const selected = /^(?:mv|move|move-item)$/.test(name) ? targets : targets.slice(-1);
		return selected.map(target => pathFinding(target.text, env, { deletion: /^(?:mv|move|move-item)$/.test(name), dynamic: target.dynamic, cwdChanged }));
	}
	if (name === "find" && lower.some(value => ["-delete", "-exec", "-execdir"].includes(value))) return [pathFinding(values[0] || ".", env, { deletion: true, dynamic: args[0]?.dynamic, cwdChanged }), confirm("find-action", "A filesystem search deletes entries or executes commands on them.")];
	if (name === "xargs") return [confirm("xargs", "Commands and their targets are assembled from input.")];
	if (name === "git") {
		let start = 0;
		while (start < values.length && values[start].startsWith("-")) { const option = values[start++]; if (["-C", "-c", "--git-dir", "--work-tree"].includes(option)) start++; }
		const sub = lower[start], rest = lower.slice(start + 1);
		if (sub === "clean" && !rest.some(value => /^-[a-z]*n|--dry-run/.test(value))) return [confirm("git-clean", "Git would remove untracked files.")];
		if (sub === "reset" && rest.includes("--hard") || sub === "restore" && !rest.includes("--staged") || sub === "checkout" && (rest.includes("--") || rest.some(value => ["-f", "--force"].includes(value)))
			|| sub === "switch" && rest.some(value => ["--discard-changes", "-f"].includes(value)) || sub === "branch" && values.slice(start + 1).includes("-D")
			|| sub === "stash" && rest.some(value => ["clear", "drop"].includes(value)) || sub === "reflog" && rest.includes("expire")) return [confirm("git-discard", "Git would discard working changes or recovery history.")];
		if (sub === "push" && rest.some(value => value.startsWith("--force") || value === "-f" || value === "--mirror" || value.startsWith("+"))) return [confirm("git-rewrite", "Git would rewrite remote references.")];
	}
	if (["docker", "podman"].includes(name) && lower.some(value => ["prune", "rm", "remove"].includes(value)) || ["kubectl", "aws", "az", "gcloud", "terraform"].includes(name) && lower.some(value => ["delete", "destroy", "rm", "rb"].includes(value))) return [confirm("remote-delete", "A container, infrastructure or remote-data deletion is requested.")];
	if (["psql", "mysql", "sqlite3", "sqlcmd"].includes(name) && values.some(value => /(?:^|;)\s*(?:drop|truncate)\b|(?:^|;)\s*delete\s+from\b/i.test(value))) return [confirm("database-delete", "A database deletion statement is requested.")];
	if (name === "reg" && lower[0] === "delete") return [confirm("registry-delete", "A Windows registry deletion is requested.")];
	return [];
}

export function assessFile(path: string, env: Environment): Assessment {
	return pathFinding(path, env) ?? { decision: "pass" };
}
