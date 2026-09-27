import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { App } from "./app.tsx";
import { AccountGate } from "./account-gate.tsx";
import type { BrowserAccount } from "./account.ts";
import { deployment, type Deployment } from "./bootstrap.ts";
import { ApiError, initialize, dispose } from "./connection.ts";
import "./style.css";

function Workspace({ account }: { account?: BrowserAccount }) {
	const [ready, setReady] = useState(false), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let active = true;
		setReady(false); setError("");
		void initialize(account).then(() => { if (active) setReady(true); }).catch(error => {
			if (active) setError(!account && error instanceof ApiError && error.status === 401
				? "For local recovery, run pi-desk open --local on this computer."
				: error instanceof Error ? error.message : "Workspace connection failed.");
		});
		return () => { active = false; dispose(); };
	}, [account, attempt]);
	if (ready) return <App account={account} />;
	return <main className="account-page"><div className="brand-mark">π</div><h1>Pi Desk</h1>
		{error ? <><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></>
			: <p role="status">Opening your workspace…</p>}</main>;
}
function Entry() {
	const [config, setConfig] = useState<Deployment>(), [error, setError] = useState("");
	useEffect(() => {
		void deployment().then(setConfig).catch(error => setError(error instanceof Error ? error.message : "Workspace unavailable."));
	}, []);
	if (config?.kind === "account") return <AccountGate origin={config.accountOrigin}>{account => <Workspace account={account} />}</AccountGate>;
	if (config?.kind === "local") return <Workspace />;
	return <main className="account-page"><div className="brand-mark">π</div><h1>Pi Desk</h1>
		{error ? <><p role="alert">{error}</p><button onClick={() => location.reload()}>Try again</button></>
			: <p role="status">Connecting…</p>}</main>;
}
createRoot(document.getElementById("root")!).render(<Entry />);
if ("serviceWorker" in navigator)
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
