const pad = (value: number) => String(value).padStart(2, "0");

/** The local date and time to the second, as host.log shows it: 2026-11-08 14:05:09. */
export function logTime(at = new Date()): string {
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * Puts the time in front of everything this process writes through the console. A string first argument gets it
 * inside the same string, so format specifiers such as %s still take the arguments after it.
 */
export function stampConsole(): void {
	for (const level of ["log", "info", "warn", "error", "debug"] as const) {
		const write = console[level].bind(console);
		console[level] = (...args: unknown[]) => typeof args[0] === "string" ? write(`${logTime()} ${args[0]}`, ...args.slice(1)) : write(logTime(), ...args);
	}
}
