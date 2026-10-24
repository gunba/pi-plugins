import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons.tsx";

/** A copy icon; it shows a tick, or a warning if the clipboard refused, for a moment after a click. */
export function CopyButton({ text, label = "Copy" }: { text: () => string; label?: string }) {
	const [status, setStatus] = useState<"Copied" | "Copy failed">();
	useEffect(() => {
		if (!status) return;
		const timer = setTimeout(() => setStatus(undefined), 1500);
		return () => clearTimeout(timer);
	}, [status]);
	return <button type="button" className="copy-button icon-button" title={status ?? label} aria-label={status ?? label} onClick={() => {
		void navigator.clipboard.writeText(text()).then(() => setStatus("Copied"), () => setStatus("Copy failed"));
	}}><Icon name={status === "Copied" ? "check" : status ? "warning" : "copy"} /></button>;
}
export function CodeBlock({ children }: { children?: ReactNode }) {
	const code = useRef<HTMLPreElement>(null);
	return <div className="code-block"><pre ref={code}>{children}</pre>
		<CopyButton text={() => code.current?.textContent ?? ""} label="Copy code" /></div>;
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
