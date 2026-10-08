export type ConfigFileView = {
	id: string; title: string; path: string; kind: string; scope: string; format: string;
	exists: boolean; loaded?: boolean; readonly?: boolean; note?: string;
};
export type ConfigSettingView = {
	key: string; label: string; type: string; description: string;
	value?: string; defaultValue?: string; choices?: string[]; global?: string; project?: string;
};
export type ConfigViewData = {
	loaded: boolean; query: string; nativeResources: boolean; warnings?: string[];
	category: string; filter: string; offset: number; total: number;
	documents: ConfigFileView[]; settings: ConfigSettingView[];
	selected?: { file: ConfigFileView; preview: string; truncated: boolean; protectedCount: number };
};

export const configCategories = [
	{ id: "all", title: "All", kinds: [] },
	{ id: "settings", title: "Pi settings", kinds: ["settings", "model"] },
	{ id: "context", title: "Instructions", kinds: ["context"] },
	{ id: "skill", title: "Skills", kinds: ["skill"] },
	{ id: "prompt", title: "Prompts", kinds: ["prompt"] },
	{ id: "extension", title: "Extensions", kinds: ["extension"] },
	{ id: "mcp", title: "MCP", kinds: ["mcp"] },
] as const;
