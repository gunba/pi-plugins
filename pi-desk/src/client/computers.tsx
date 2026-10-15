import { useEffect, useState } from "react";
import { api, removeComputer, renameComputer, refreshDirectory } from "./connection.ts";
import type { Computer } from "./workspace.ts";
import type { BrowserAccount, AccountDirectory } from "./account.ts";
import { useConfirmation } from "./confirmation.tsx";
import { connectionLabel, connectionTone } from "./connection-state.ts";

export function Computers({ computers, account }: { computers: Computer[]; account: BrowserAccount }) {
	const [error, setError] = useState(""), [busy, setBusy] = useState(false);
	return <>
		<section className="panel-card computers">
			<h3>Account workspace</h3><p>{account.account()?.username}</p>
			<p className="muted">Sessions stay on their computer. Closing this app does not stop their work.</p>
			<button disabled={busy} onClick={() => {
				setBusy(true); setError("");
				void account.signOut().catch(error => setError(String(error))).finally(() => setBusy(false));
			}}>Sign out of this browser</button>
			{error && <p role="alert" className="error-text">{error}</p>}
		</section>
		<section className="panel-card computers">
			<h3>Computers</h3>
			{computers.map(computer => <ComputerCard key={computer.id} computer={computer} />)}
			{!computers.length && <p>No computers are enrolled yet.</p>}
			<details><summary>Add a computer</summary>
				<p>Run this on the computer, sign in with the same account, then start Pi Desk:</p>
				<pre><code>pi-desk signin --workspace {location.origin}{"\n"}pi-desk start</code></pre>
				<p className="muted">It will appear automatically on every signed-in device.</p>
			</details>
		</section>
		<AccountBrowsers account={account} />
	</>;
}
function ComputerCard({ computer }: { computer: Computer }) {
	const [name, setName] = useState(computer.name), [error, setError] = useState(""), [busy, setBusy] = useState(false);
	const confirmation = useConfirmation(computer.id);
	useEffect(() => setName(computer.name), [computer.name]);
	const run = (work: () => Promise<void>) => {
		setBusy(true); setError("");
		void work().catch(error => setError(String(error))).finally(() => setBusy(false));
	};
	const updates = computer.updates;
	return <details className="computer-card" open={!!updates?.available || updates?.phase === "waiting" || updates?.phase === "failed"}>
		<summary><span className={`status-dot ${connectionTone(computer)}`} /><strong>{computer.name}</strong>
			{computer.release && <span className="computer-version">Desk {computer.release.version}</span>}
			<small>{connectionLabel(computer)}</small></summary>
		{computer.error && <p role="alert" className="error-text">{computer.error}</p>}
		{computer.presence && !computer.presence.online && <p className="muted">No recent contact. Last seen {new Date(computer.presence.seen).toLocaleString()}.</p>}
		{computer.connection === "upgrade" && <p>This app is newer than the computer expects. <button className="quiet-action" onClick={() => location.reload()}>Reload app</button></p>}
		<SoftwareUpdate computer={computer} />
		<details className="computer-more"><summary>Name and removal</summary>
			<form className="computer-rename" onSubmit={event => { event.preventDefault(); run(() => renameComputer(computer.id, name)); }}>
				<input aria-label="Computer name" maxLength={100} value={name} onChange={event => setName(event.target.value)} required />
				<button disabled={busy || name.trim() === computer.name}>Rename</button>
			</form>
			<button className="danger-action" disabled={busy} onClick={() => {
				void confirmation.request({ title: "Remove computer?", context: computer.name, accept: "Remove computer",
					body: <p>Remove this computer from the workspace on every device. Existing connections lose access within one minute.
						Running Pi sessions remain on the computer. Sign in there again to enrol it again.</p>,
				}).then(accepted => { if (accepted) run(() => removeComputer(computer.id)); });
			}}>Remove from workspace</button>
		</details>
		<details className="computer-more"><summary>Connection details</summary>
			<dl className="computer-facts">
				<dt>Computer ID</dt><dd>{computer.id}</dd>
				{computer.release && <><dt>Versions</dt><dd>Desk {computer.release.version} · API {computer.release.api} · Pi {computer.release.engine}</dd></>}
				<dt>Browser link</dt><dd>{connectionLabel(computer)}; switching away pauses this app's connection, not Pi.</dd>
				{computer.presence && <><dt>Last contact</dt><dd>{new Date(computer.presence.seen).toLocaleString()}</dd></>}
				<dt>Interruptions</dt><dd>{computer.diagnostics?.interruptions ?? 0} since this app opened
					{computer.diagnostics?.last && <>; last: {computer.diagnostics.last.reason}{computer.diagnostics.last.code === undefined ? "" : ` (code ${computer.diagnostics.last.code})`},
						{" "}{new Date(computer.diagnostics.last.at).toLocaleString()}</>}</dd>
			</dl>
		</details>
		{error && <p role="alert" className="error-text">{error}</p>}
		{confirmation.dialog}
	</details>;
}
/** "2 min ago", "3 h ago", or a date for older checks. */
function ago(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
	return new Date(at).toLocaleDateString([], { day: "numeric", month: "short" });
}
export function SoftwareUpdate({ computer }: { computer: Pick<Computer, "name" | "connected" | "updates"> & { id?: string } }) {
	const [error, setError] = useState(""), [busy, setBusy] = useState(false), [restarted, setRestarted] = useState("");
	// A check runs in the background; Update now checks first so it never offers a release that has since been replaced.
	const [awaiting, setAwaiting] = useState<{ since: number; then: "update" | "check"; deadline: number }>();
	const confirmation = useConfirmation(`${computer.id ?? "local"}:update`);
	const updates = computer.updates;
	const run = (path: string, body = {}) => {
		setBusy(true); setError("");
		return api(path, body, computer.id).catch(error => { setError(String(error)); throw error; }).finally(() => setBusy(false));
	};
	const confirmUpdate = () => {
		if (!updates) return;
		const prepared = updates.pendingId, version = updates.available;
		if (!prepared && !version) return;
		void confirmation.request({ title: `Update ${computer.name} to Desk ${prepared ? updates.pending : version}?`, context: `Now on ${updates.current}`, accept: "Update now",
			body: <p>Desk restarts on this computer and restores its conversations; this browser reconnects by itself.
				Running tools are interrupted; agents that were working carry on once, and idle conversations stay idle.
				Messages still being sent must finish first.</p>,
		}).then(accepted => { if (accepted) void run(prepared ? "/runtime/apply" : "/runtime/update-now", prepared ? { prepared } : { version }).catch(() => {}); });
	};
	const check = (then: "update" | "check") => {
		if (!updates) return;
		setAwaiting({ since: updates.checkedAt ?? 0, then, deadline: Date.now() + 90_000 });
		void run("/runtime/check").catch(() => setAwaiting(undefined));
	};
	useEffect(() => {
		if (!awaiting || !updates) return;
		if (Date.now() > awaiting.deadline) { setAwaiting(undefined); setError("The update check did not finish. Try again."); return; }
		if (updates.checking || (updates.checkedAt ?? 0) <= awaiting.since) {
			const timer = setTimeout(() => setAwaiting(current => current && { ...current }), 2000);
			return () => clearTimeout(timer);
		}
		setAwaiting(undefined);
		if (awaiting.then === "update") confirmUpdate();
	}, [awaiting, updates?.checking, updates?.checkedAt]);
	if (!updates) return null;
	const working = ["preparing", "applying"].includes(updates.phase), checking = !!awaiting || !!updates.checking;
	const offer = updates.pendingId ? updates.pending : updates.available;
	return <section className="computer-update" aria-label="Software update">
		<div className="update-line">
			{working ? <span role="status">{updates.phase === "preparing" ? "Preparing" : "Applying"} Desk {offer ?? "update"}…</span>
				: updates.phase === "waiting" ? <span role="status">Waiting for {updates.activeSessions ?? 0} open Pi sessions to close{updates.pending ? `; Desk ${updates.pending} is ready` : ""}.</span>
				: offer ? <span role="status"><strong>Desk {offer} is available</strong></span>
				: <span className="muted">{updates.checkedAt && !updates.checkError ? `Up to date · checked ${ago(updates.checkedAt)}` : `Desk ${updates.current}`}</span>}
			{!working && updates.phase !== "waiting" && (offer
				? <button className="primary" disabled={busy || checking || !computer.connected} onClick={() => check("update")}>{checking ? "Checking…" : "Update now"}</button>
				: <button className="quiet-action" disabled={busy || checking || !computer.connected} onClick={() => check("check")}>{checking ? "Checking…" : "Check now"}</button>)}
		</div>
		{updates.phase === "failed" && updates.message && <p role="alert" className="error-text">{/published release changed/i.test(updates.message)
			? "A newer release replaced the one offered. Update now checks again and offers the latest." : updates.message}</p>}
		{updates.checkError && <p className="error-text">Couldn't check for updates: {updates.checkError}</p>}
		{offer && !working && updates.automatic?.host && updates.waiting && <p className="muted">Updating automatically when possible: {updates.waiting.charAt(0).toLowerCase() + updates.waiting.slice(1)}.</p>}
		{updates.automatic && <div className="automatic-updates">
			<label className="setting-control"><span>Update Desk automatically<small>Within an hour of each release. Running conversations carry on undisturbed.</small></span>
				<input type="checkbox" role="switch" checked={updates.automatic.host} disabled={busy || !computer.connected}
					onChange={event => void run("/runtime/automatic", { host: event.target.checked }).catch(() => {})} /></label>
			<label className="setting-control"><span>Move idle conversations to the new version<small>Each restarts once it has been idle for 10 minutes, with no agents, plans or commands still running. History is kept, and messages sent meanwhile wait for it.</small></span>
				<input type="checkbox" role="switch" checked={updates.automatic.conversations} disabled={busy || !computer.connected}
					onChange={event => void run("/runtime/automatic", { conversations: event.target.checked }).catch(() => {})} /></label>
		</div>}
		{!!updates.outdated && <div className="outdated-conversations">
			<span>{updates.outdated === 1 ? "1 conversation is" : `${updates.outdated} conversations are`} on an older Desk.</span>
			<button className="quiet-action" disabled={busy || !computer.connected} onClick={() => {
				setBusy(true); setError(""); setRestarted("");
				void api<{ restarting: number; skipped: { title: string; reason: string }[] }>("/runtime/restart-idle", {}, computer.id).then(result => {
					setRestarted([result.restarting ? `Restarting ${result.restarting} idle conversation${result.restarting === 1 ? "" : "s"}.` : "No conversation can be restarted right now.",
						...result.skipped.map(item => `${item.title || "A conversation"} ${item.reason}.`)].join(" "));
				}).catch(error => setError(String(error))).finally(() => setBusy(false));
			}}>Restart idle ones now</button>
			{restarted && <p className="muted">{restarted}</p>}
		</div>}
		{error && <p role="alert" className="error-text">{error}</p>}
		{confirmation.dialog}
	</section>;
}
function AccountBrowsers({ account }: { account: BrowserAccount }) {
	const [devices, setDevices] = useState<AccountDirectory["devices"]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
	const confirmation = useConfirmation(account.config.origin);
	const refresh = async () => { setDevices((await account.directory()).devices.filter(device => device.kind === "browser")); };
	useEffect(() => { void refresh().catch(error => setError(String(error))); }, [account]);
	return <section className="panel-card">
		<h3>Browser access</h3>
		{devices.map(device => <div className="device-row" key={device.id}>
			<div><strong>{device.name}</strong><small>Enrolled {new Date(device.created).toLocaleDateString()} · {device.id.slice(0, 8)}</small></div>
			<button disabled={busy} onClick={() => {
				void confirmation.request({ title: "Remove browser access?", context: device.name, accept: "Remove access",
					body: <p>This browser loses access to all computers within one minute. Existing Pi work continues.</p>,
				}).then(async accepted => {
					if (!accepted) return;
					setBusy(true); setError("");
					try {
						if (device.id === await account.deviceId()) { await account.signOut(); return; }
						await account.request(`/devices/${device.id}/revoke`, {}); await refresh(); await refreshDirectory(true);
					}
					catch (error) { setError(String(error)); }
					finally { setBusy(false); }
				});
			}}>Remove access</button>
		</div>)}
		{error && <p role="alert" className="error-text">{error}</p>}
		{confirmation.dialog}
	</section>;
}
