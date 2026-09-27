import { useEffect, useState } from "react";
import { api } from "./connection.ts";

interface Device { id: string; label: string; created: number }
export function Devices() {
	const [devices, setDevices] = useState<Device[]>([]), [error, setError] = useState("");
	const refresh = () => { void api<Device[]>("/devices").then(setDevices).catch(error => setError(String(error))); };
	useEffect(refresh, []);
	return <section className="panel-card">
		<h3>Local recovery access</h3>
		<p className="muted">These windows can access this computer through its loopback interface.</p>
		{devices.map(device => <div className="device-row" key={device.id}>
			<div><strong>{device.label}</strong><small>{new Date(device.created).toLocaleDateString()}</small></div>
			<button aria-label={`Revoke ${device.label}`} onClick={() => {
				void api("/revoke", { id: device.id }).then(refresh).catch(error => setError(String(error)));
			}}>Revoke</button>
		</div>)}
		{error && <p className="error-text">{error}</p>}
	</section>;
}
