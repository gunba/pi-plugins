import { useEffect, useState, type ReactNode } from "react";
import { BrowserAccount, BrowserSignInRequired } from "./account.ts";
import "./account.css";

export function AccountGate({ origin, children }: { origin: string; children: (account: BrowserAccount) => ReactNode }) {
	const [attempt, setAttempt] = useState(0);
	const [client, setClient] = useState<BrowserAccount>();
	const [phase, setPhase] = useState<"opening" | "signin" | "joining" | "ready" | "error">("opening");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let active = true, account: BrowserAccount | undefined, unwatch: (() => void) | undefined, revision = 0;
		setPhase("opening"); setClient(undefined); setError("");
		const refresh = async () => {
			const current = ++revision;
			if (!active || !account) return;
			if (!account.signedIn()) { setPhase("signin"); return; }
			setPhase("joining");
			try {
				await account.enrol();
				if (active && current === revision) { setError(""); setPhase("ready"); }
			} catch (error) {
				if (!active || current !== revision) return;
				setError(error instanceof Error ? error.message : "Account connection failed.");
				setPhase(error instanceof BrowserSignInRequired || !account.signedIn() ? "signin" : "error");
			}
		};
		void BrowserAccount.open(origin).then(value => {
			if (!active) { value.close(); return; }
			account = value; setClient(value); unwatch = value.watch(() => { void refresh(); }); return refresh();
		}).catch(error => {
			if (!active) return;
			setError(error instanceof Error ? error.message : "Account service unavailable."); setPhase("error");
		});
		return () => { active = false; revision++; unwatch?.(); account?.close(); };
	}, [origin, attempt]);
	if (phase === "ready" && client) return children(client);
	return <main className="account-page">
		<div className="brand-mark" aria-hidden="true">π</div>
		<h1>Your workspace, anywhere.</h1>
		<p>Sign in to access your computers and conversations.</p>
		{(phase === "opening" || phase === "joining") && <p role="status">{phase === "opening" ? "Connecting…" : "Opening your workspace…"}</p>}
		{phase === "signin" && client && <button className="primary" disabled={busy} onClick={() => {
			setBusy(true); setError("");
			void client.signIn().catch(error => { setBusy(false); setError(error instanceof Error ? error.message : "Sign-in did not complete."); });
		}}>Continue with Microsoft</button>}
		{phase === "error" && <button onClick={() => setAttempt(value => value + 1)}>Try again</button>}
		{error && <p role="alert" className="error-text">{error}</p>}
	</main>;
}
