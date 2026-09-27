import { useEffect, useState } from "react";
import { removeComputer, renameComputer, refreshDirectory } from "./connection.ts";
import type { Computer } from "./workspace.ts";
import type { BrowserAccount, AccountDirectory } from "./account.ts";
import { useConfirmation } from "./confirmation.tsx";

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
	return <details className="computer-card">
		<summary><span className={`status-dot ${computer.online ? "online" : "offline"}`} />{computer.name}
			<small>{computer.upgrade ? "Update required" : computer.online ? "Connected" : "Offline"}</small></summary>
		<p className="muted">{computer.id.slice(0, 8)}{computer.error ? ` · ${computer.error}` : ""}</p>
		{computer.release && <p className="muted">Host {computer.release.version} · API {computer.release.api} · Pi {computer.release.engine}</p>}
		{computer.upgrade && <button onClick={() => location.reload()}>Reload app</button>}
		<form onSubmit={event => { event.preventDefault(); run(() => renameComputer(computer.id, name)); }}>
			<label>Computer name<input aria-label="Computer name" maxLength={100} value={name} onChange={event => setName(event.target.value)} required /></label>
			<button disabled={busy}>Save name</button>
		</form>
		<button disabled={busy} onClick={() => {
			void confirmation.request({ title: "Remove computer?", context: computer.name, accept: "Remove computer",
				body: <p>Remove this computer from the workspace on every device. Existing connections lose access within one minute.
					Running Pi sessions remain on the computer. Sign in there again to enrol it again.</p>,
			}).then(accepted => { if (accepted) run(() => removeComputer(computer.id)); });
		}}>Remove computer</button>
		{error && <p role="alert" className="error-text">{error}</p>}
		{confirmation.dialog}
	</details>;
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
