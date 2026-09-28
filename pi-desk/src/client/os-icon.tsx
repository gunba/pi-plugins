export function OsIcon({ platform }: { platform?: string }) {
	const name = platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform === "darwin" ? "macOS" : "Computer";
	return <svg className="os-icon" viewBox="0 0 24 24" role="img" aria-label={name}>
		{platform === "win32" ? <path fill="currentColor" d="M2 3h9v8H2zm11 0h9v8h-9zM2 13h9v8H2zm11 0h9v8h-9z" />
			: platform === "linux" ? <>
				<path fill="currentColor" d="M8 6a4 4 0 0 1 8 0v3c1 2 4 6 3 9H5c-1-3 2-7 3-9Z" />
				<ellipse cx="12" cy="15" rx="4" ry="5" fill="var(--sidebar)" />
				<ellipse cx="10.4" cy="6.8" rx="1" ry="1.4" fill="var(--sidebar)" />
				<ellipse cx="13.6" cy="6.8" rx="1" ry="1.4" fill="var(--sidebar)" />
				<path d="m9 9 3-1 3 1-3 2Zm-3 9-3 3h7l-1-3Zm9 0-1 3h7l-3-3Z" fill="currentColor" />
			</> : <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
				<rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8m-4-4v4" />
			</g>}
	</svg>;
}
