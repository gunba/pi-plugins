type ViewImageArguments = { path: string };

export function prepareViewImageArguments(args: unknown): ViewImageArguments {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args as ViewImageArguments;
	const value = args as Record<string, unknown>;
	if (value.path !== undefined && typeof value.path !== "string") throw new Error("path must be a string");
	const prepared = { ...value };
	const path = [value.path, value.file_path, value.image_path].find(value => typeof value === "string" && value.length > 0);
	if (path !== undefined) {
		prepared.path = path;
		delete prepared.file_path;
		delete prepared.image_path;
	}
	return prepared as ViewImageArguments;
}
