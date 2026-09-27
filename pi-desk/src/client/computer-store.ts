import { validId, validSecret } from "../shared/secure-channel.ts";
import type { RemoteCredential } from "./remote.ts";

export const COMPUTER_PREFIX = "pi-desk:computer:";
export interface SavedComputer { credential: RemoteCredential; name: string; alias?: string }
export function readComputers(): SavedComputer[] {
	const result: SavedComputer[] = [];
	for (let index = 0; index < localStorage.length; index++) {
		const key = localStorage.key(index)!;
		if (!key.startsWith(COMPUTER_PREFIX)) continue;
		try {
			const value = JSON.parse(localStorage.getItem(key)!) as SavedComputer, credential = value.credential;
			if (credential && key === COMPUTER_PREFIX + credential.host && validId(credential.host) && validId(credential.device)
				&& validSecret(credential.key) && (credential.invitation === undefined || validSecret(credential.invitation))
				&& typeof credential.label === "string" && typeof value.name === "string"
				&& (value.alias === undefined || typeof value.alias === "string")) result.push(value);
		} catch {}
	}
	return result;
}
export function saveComputer(value: SavedComputer): void {
	localStorage.setItem(COMPUTER_PREFIX + value.credential.host, JSON.stringify(value));
}
export function forgetComputer(id: string): void { localStorage.removeItem(COMPUTER_PREFIX + id); }
