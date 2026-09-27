import { useEffect, useState } from "react";
import { pair, removeComputer, renameComputer } from "./connection.ts";
import type { Computer } from "./workspace.ts";
import { Devices } from "./devices.tsx";
import { useConfirmation } from "./confirmation.tsx";

export function Computers({ computers }: { computers: Computer[] }) {
	const [invitation, setInvitation] = useState(""), [error, setError] = useState("");
	return <section className="panel-card computers">
		<h3>Computers</h3>
		<p className="muted">Sessions stay on their computer. Closing this app does not stop their work.</p>
		{computers.map(computer => <ComputerCard key={computer.id} computer={computer} />)}
		<details><summary>Connect another computer</summary>
			<form onSubmit={event => {
				event.preventDefault();
				void pair(invitation).then(() => { setInvitation(""); setError(""); }).catch(error => setError(String(error)));
			}}>
				<label>Pairing invitation<input value={invitation} onChange={event => setInvitation(event.target.value)}
					aria-label="Computer invitation" autoComplete="off" spellCheck={false} required /></label>
				<button>Connect computer</button>
			</form>
			<p className="muted">Use an invitation from Pi Desk on that computer, connected to this same server.</p>
		</details>
		{error && <p role="alert" className="error-text">{error}</p>}
	</section>;
}
function ComputerCard({ computer }: { computer: Computer }) {
	const [name, setName] = useState(computer.name);
	const confirmation = useConfirmation(computer.id);
	useEffect(() => setName(computer.name), [computer.name]);
	return <details className="computer-card">
		<summary><span className={`status-dot ${computer.online ? "online" : "offline"}`} />{computer.name}
			<small>{computer.upgrade ? "Update required" : computer.online ? "Connected" : "Offline"}</small></summary>
		<p className="muted">{computer.id.slice(0, 8)}{computer.error ? ` · ${computer.error}` : ""}</p>
		{computer.release && <p className="muted">Host {computer.release.version} · API {computer.release.api} · Pi {computer.release.engine}</p>}
		{computer.upgrade && <button onClick={() => location.reload()}>Reload app</button>}
		<form onSubmit={event => { event.preventDefault(); renameComputer(computer.id, name); }}>
			<label>Name on this browser<input aria-label="Computer name" maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
			<button>Save computer name</button>
		</form>
		{computer.online && <Devices relay={computer.relay} computer={computer.id} />}
		<button onClick={() => {
			void confirmation.request({ title: "Forget computer?", context: computer.name, accept: "Forget computer",
				body: <p>Remove its pairing from this browser. You will need a new invitation to reconnect.
					This does not stop sessions or revoke access on other devices.</p>,
			}).then(accepted => { if (accepted) removeComputer(computer.id); });
		}}>Forget computer</button>
		{confirmation.dialog}
	</details>;
}
