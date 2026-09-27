import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function CopyButton({ text, label = "Copy" }: { text: () => string; label?: string }) {
	const [status, setStatus] = useState("");
	return <button type="button" className="copy-button" aria-label={label} onClick={() => {
		void navigator.clipboard.writeText(text()).then(() => setStatus("Copied"), () => setStatus("Copy failed"));
	}}>{status || label}</button>;
}
export function CodeBlock({ children }: { children?: ReactNode }) {
	const code = useRef<HTMLPreElement>(null);
	return <div className="code-block"><CopyButton text={() => code.current?.textContent ?? ""} label="Copy code" />
		<pre ref={code}>{children}</pre></div>;
}
export function Elapsed({ started }: { started: number }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1000);
		return () => clearInterval(timer);
	}, []);
	return <span>{Math.max(0, Math.floor((now - started) / 1000))}s</span>;
}
export function LiveOutput({ text }: { text: string }) {
	const node = useRef<HTMLPreElement>(null);
	useLayoutEffect(() => { if (node.current) node.current.scrollTop = node.current.scrollHeight; }, [text]);
	return <pre ref={node} className="live-output">{text}</pre>;
}
