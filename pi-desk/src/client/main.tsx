import { createRoot } from "react-dom/client";
import { Loading } from "./loading.tsx";
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { App } from "./app.tsx";
import { AccountGate } from "./account-gate.tsx";
import type { BrowserAccount } from "./account.ts";
import { deployment, type Deployment } from "./bootstrap.ts";
import { ApiError, initialize, dispose, reportCrash } from "./connection.ts";
import { startUpdateChecks } from "./app-update.ts";
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
			: <Loading label="Opening your workspace…" />}</main>;
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
			: <Loading label="Connecting to your workspace…" />}</main>;
}
/**
 * An error while rendering unmounts the whole app and leaves a blank page. This shows the error instead and tells the
 * connected computers, which keep it in client-errors.log in Desk's folder.
 */
class Crash extends Component<{ children: ReactNode }, { error?: Error }> {
	state: { error?: Error } = {};
	static getDerivedStateFromError(error: Error) { return { error }; }
	componentDidCatch(error: Error, info: ErrorInfo) {
		reportCrash({ message: String(error?.message ?? error), stack: error?.stack, component: info.componentStack ?? undefined,
			release: document.querySelector<HTMLScriptElement>("script[type=module][src]")?.src.split("/").pop(), device: navigator.userAgent });
	}
	render() {
		const { error } = this.state;
		if (!error) return this.props.children;
		return <main className="account-page crash-page"><div className="brand-mark">π</div><h1>Desk stopped after an error</h1>
			<p role="alert">{String(error.message ?? error)}</p><button onClick={() => location.reload()}>Reload</button>
			<pre>{error.stack}</pre></main>;
	}
}
createRoot(document.getElementById("root")!).render(<Crash><Entry /></Crash>);
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
  startUpdateChecks();
}
