import { useEffect, useRef, useState } from "react";
import type { SessionView } from "../shared/protocol.ts";
import type { BlobLease } from "./blob-pool.ts";
import { acquirePicture, loadedPicture } from "./connection.ts";

/**
 * The URL of a conversation's banner picture once it has loaded, from the first render when it is loaded already. A
 * new version replaces the old one only when it has loaded, so a renamed conversation keeps its banner until the new
 * one is ready.
 */
export function usePicture(session: SessionView | undefined): string | undefined {
	const key = session?.key, version = session?.picture?.version;
	const [shown, setShown] = useState<{ key: string; url: string }>();
	const held = useRef<BlobLease>(undefined);
	useEffect(() => {
		if (!key || !version) { held.current?.release(); held.current = undefined; return; }
		const lease = acquirePicture(key, version);
		let live = true;
		void lease.loaded.then(url => {
			if (!live) return;
			held.current?.release(); held.current = lease;
			setShown({ key, url });
		}, () => {});
		return () => { live = false; if (held.current !== lease) lease.release(); };
	}, [key, version]);
	useEffect(() => () => { held.current?.release(); held.current = undefined; }, []);
	const ready = key && version ? loadedPicture(key, version)?.url : undefined;
	return ready ?? (version && shown && shown.key === key ? shown.url : undefined);
}

/** A conversation's banner behind a sidebar row or the top bar, faded where the text is (style.css). */
export function Banner({ session, className }: { session: SessionView | undefined; className: string }) {
	const url = usePicture(session);
	return url ? <BannerPicture key={session!.key} session={session!} url={url} className={className} /> : null;
}
function BannerPicture({ session, url, className }: { session: SessionView; url: string; className: string }) {
	// A banner that has only just loaded fades in. One loaded earlier, as when a folded section opens again, is
	// shown at once: fading it in each time looked like it was loading again.
	const [arriving] = useState(() => {
		const version = session.picture?.version, loaded = version ? loadedPicture(session.key, version) : undefined;
		return !loaded || performance.now() - loaded.at < 300;
	});
	return <span className={arriving ? `${className} picture-arriving` : className} aria-hidden="true" style={{ backgroundImage: `url("${url}")` }} />;
}
