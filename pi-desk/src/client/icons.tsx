import type { ReactNode } from "react";

const paths: Record<string, ReactNode> = {
	settings: <><path d="m9 3-1 3-3 1v4l3 1 1 3h4l1-3 3-1V7l-3-1-1-3Z" transform="translate(1 3)" /><circle cx="12" cy="12" r="3" /></>,
	chat: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z" />,
	folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
	download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
	preview: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
	computer: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
	tools: <path d="m14 6 4 4 3-3a6 6 0 0 1-8 7l-7 7-3-3 7-7a6 6 0 0 1 7-8Z" />,
	activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
	clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
	thinking: <><path d="M12 18V6a3 3 0 0 0-6-1 4 4 0 0 0-3 6 4 4 0 0 0 3 7 3 3 0 0 0 6 0Zm0-12a3 3 0 0 1 6-1 4 4 0 0 1 3 6 4 4 0 0 1-3 7 3 3 0 0 1-6 0" /><path d="M6 5v3m12-3v3M6 18v-3m12 3v-3M3 11h3m15 0h-3" /></>,
	party: <><circle cx="9" cy="7" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3" /></>,
	terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m6 8 4 4-4 4m7 0h5" /></>,
	plug: <><path d="M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0Zm5 8v5" /></>,
	usage: <><path d="M12 3v9h9A9 9 0 1 1 12 3Z" /><path d="M16 3a7 7 0 0 1 5 5h-5Z" /></>,
	code: <><path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-11-2 14" /></>,
	sliders: <><path d="M4 7h4m4 0h8M4 17h8m4 0h4" /><circle cx="10" cy="7" r="2" /><circle cx="14" cy="17" r="2" /></>,
	layers: <><path d="m12 3 10 5-10 5L2 8Zm-9 10 9 5 9-5M3 18l9 4 9-4" /></>,
	context: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M8 5v14m5-8h4m-4 4h4" /></>,
	globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
	account: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
	info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></>,
	refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5 8a8 8 0 0 1 14-3l1 3M4 16l1 3a8 8 0 0 0 14-3" /></>,
	switch: <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />,
	star: <path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4L2.8 9.7l6.4-.9L12 3Z" />,
	trash: <><path d="M4 7h16M9 3h6l1 4M6 7l1 14h10l1-14M10 11v6m4-6v6" /></>,
	login: <><path d="M14 3h6v18h-6M3 12h12m-4-4 4 4-4 4" /></>,
	edit: <><path d="m4 16 12-12 4 4L8 20H4Zm10-10 4 4" /></>,
	check: <path d="m5 12 4 4L19 6" />,
	close: <path d="m6 6 12 12M18 6 6 18" />,
	warning: <><path d="m12 3 10 18H2Z" /><path d="M12 9v5m0 3v.1" /></>,
	more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
	plus: <path d="M12 5v14M5 12h14" />,
	send: <path d="M12 18V6m-5 5 5-5 5 5" />,
	"send-now": <path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z" />,
	expand: <path d="M14 3h7v7m0-7-8 8M10 21H3v-7m0 7 8-8" />,
	plan: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="m7 8 1 1 2-2m3 1h4m-10 7 1 1 2-2m3 1h4" /></>,
	pause: <path d="M8 5v14m8-14v14" />,
	play: <path d="m8 4 12 8-12 8Z" />,
	steer: <><path d="M5 20V9a4 4 0 0 1 4-4h10m-4-4 4 4-4 4" /><path d="M5 14h9a4 4 0 0 1 4 4v2" /></>,
	queue: <><path d="M4 6h16M4 12h10M4 18h10m3-6 5 3-5 3" /></>,
};
export function Icon({ name, className = "" }: { name: string; className?: string }) {
	return <svg className={`ui-icon ${className}`} viewBox="0 0 24 24" aria-hidden="true"
		fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name] ?? paths.settings}</svg>;
}
const sections: Record<string, string> = {
	general: "settings", conversation: "chat", accounts: "account", computers: "computer", context: "context", tools: "tools", activity: "activity",
	"desk-mcp": "plug", "pi-usage": "usage", "codex-wire": "code", config: "sliders",
	"pi-context-ledger": "layers", "context-window": "context", "desk-browser": "globe", plan: "plan", "pi-party": "party", party: "party", subagents: "layers",
};
export function SectionIcon({ id }: { id: string }) { return <Icon name={sections[id] ?? "settings"} />; }

export function ProviderIcon({ id, title }: { id: string; title: string }) {
	const brand = id.startsWith("openai") ? "openai" : id.startsWith("google") ? "google" : id.startsWith("anthropic") ? "anthropic" : "other";
	return <span className={`provider-icon provider-${brand}`} aria-hidden="true">
		{brand === "anthropic" ? <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 4h3l7 16h-3.5l-1.4-3.5H6L4.5 20H1Zm-.9 9.7h4.8L9.5 7.8ZM15 4h3l7 16h-3.2Z" /></svg>
			: brand === "google" ? <svg viewBox="0 0 24 24" fill="none" strokeWidth="4"><path stroke="#4285f4" d="M20.8 10.2v2c0 3-1.5 5.3-4 6.5" /><path stroke="#34a853" d="M17.6 18.2a9 9 0 0 1-13.7-3.7" /><path stroke="#fbbc05" d="M4.1 15.1a9 9 0 0 1 0-6.2" /><path stroke="#ea4335" d="M3.9 9.5A9 9 0 0 1 18 5" /><path stroke="#4285f4" d="M12 11.7h9" /></svg>
			: brand === "openai" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
				{[0, 60, 120, 180, 240, 300].map(angle => <path key={angle} transform={`rotate(${angle} 12 12)`} d="M12 5c0-4 7-4 8-1s-1 5-4 7l-4 2V8l4-2" />)}
			</svg> : <span>{title.slice(0, 2).toUpperCase()}</span>}
	</span>;
}
