import { useEffect, useRef, useState } from "react";
import { acquireAsset } from "./connection.ts";
import type { BlobLease } from "./blob-pool.ts";
import { useReferenceQuery } from "./reference-origin.tsx";

export function AssetImage({ session, asset }: { session: string; asset: string }) {
	const origin = useReferenceQuery();
	const root = useRef<HTMLDivElement>(null);
	const [url, setUrl] = useState("");
	const [error, setError] = useState("");
	const [attempt, retry] = useState(0);
	useEffect(() => {
		setUrl(""); setError("");
		let disposed = false;
		let current: BlobLease | undefined;
		const observer = new IntersectionObserver(entries => {
			if (!entries.some(entry => entry.isIntersecting)) {
				root.current!.style.minHeight = `${root.current!.getBoundingClientRect().height}px`;
				current?.release(); current = undefined; setUrl(""); return;
			}
			if (current) return;
			const lease = current = acquireAsset(session, asset, origin);
			setError("");
			void lease.loaded.then(url => {
				if (!disposed && current === lease) setUrl(url);
			}).catch(error => { if (!disposed && current === lease) setError(String(error)); });
		}, { rootMargin: "200px" });
		observer.observe(root.current!);
		return () => { disposed = true; observer.disconnect(); current?.release(); };
	}, [session, asset, origin, attempt]);
	return <div ref={root} className="asset-image">
		{url ? <a href={url} target="_blank" rel="noreferrer"><img className="output-image" alt="Conversation image" src={url}
			onLoad={() => { if (root.current) root.current.style.minHeight = ""; }} onError={() => setError("This image could not be decoded.")} /></a>
			: <p className="muted">{error || "Loading image…"}</p>}
		{url && error && <p className="error-text">{error}</p>}
		{error && <button onClick={() => retry(value => value + 1)}>Retry image</button>}
	</div>;
}
export function AssetLink({ session, asset }: { session: string; asset: string }) {
	const origin = useReferenceQuery();
	const [error, setError] = useState("");
	const lease = useRef<BlobLease | undefined>(undefined);
	useEffect(() => () => { lease.current?.release(); lease.current = undefined; }, [session, asset, origin]);
	return <><button className="full-output" onClick={() => {
		const page = window.open("about:blank", "_blank");
		if (page) page.opener = null;
		setError("");
		const current = lease.current ??= acquireAsset(session, asset, origin);
		void current.loaded.then(url => {
			if (lease.current !== current) { page?.close(); return; }
			if (page) page.location.href = url;
			else {
				const link = document.createElement("a"); link.href = url; link.download = "pi-output.txt"; link.click();
			}
		}).catch(error => {
			page?.close();
			if (lease.current === current) { current.release(); lease.current = undefined; setError(String(error)); }
		});
	}}>Open complete output ↗</button>{error && <p className="error-text">{error}</p>}</>;
}
