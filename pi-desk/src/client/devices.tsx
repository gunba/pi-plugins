import { useEffect, useState } from "react";
import { api } from "./connection.ts";
import type { HostState } from "../shared/protocol.ts";

interface Device { id: string; label: string; created: number; kind: string; pending?: boolean }
export function Devices({ relay, computer }: { relay: HostState["relay"]; computer?: string }) {
	const [devices, setDevices] = useState<Device[]>([]);
	const [invitation, setInvitation] = useState("");
	const [error, setError] = useState("");
	const refresh = () => { void api<Device[]>("/devices", undefined, computer).then(setDevices).catch(error => setError(String(error))); };
	useEffect(refresh, []);
	return <section className="panel-card">
		<h3>Device access</h3>
		<p className="muted">{relay ? `Relay ${relay.state} · ${relay.origin}` : "Local access"}</p>
		{relay?.error && <p className="error-text">{relay.error}</p>}
		<button onClick={() => {
			void (relay ? api<{ url: string }>("/remote/invite", {}, computer) :
				api<{ token: string }>("/invite", {}, computer).then(result => ({ url: `${location.origin}/#pair=${result.token}` })))
				.then(result => { setInvitation(result.url); refresh(); }).catch(error => setError(String(error)));
		}}>{relay ? "Pair a phone or another device" : "Pair another local browser"}</button>
		{invitation && <div className="invitation">
			<p>Open this link on your other device within 10 minutes. It gives access to Pi and its tools on this computer.</p>
			<textarea aria-label="Device invitation" readOnly value={invitation} rows={4} onFocus={event => event.target.select()} />
			<button onClick={() => { void navigator.clipboard.writeText(invitation).catch(error => setError(String(error))); }}>Copy invitation</button>
		</div>}
		{devices.map(device => <div className="device-row" key={device.id}>
			<div><strong>{device.label}</strong><small>{device.kind}{device.pending ? " · waiting to pair" : ""}</small></div>
			<button aria-label={`Revoke ${device.label}`} onClick={() => {
				void api("/revoke", { id: device.id }, computer).then(refresh).catch(error => setError(String(error)));
			}}>Revoke</button>
		</div>)}
		{error && <p className="error-text">{error}</p>}
	</section>;
}
