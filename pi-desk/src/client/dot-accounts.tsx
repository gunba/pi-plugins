import { useEffect, useRef, useState } from "react";
import { api } from "./connection.ts";
import { SignIn } from "./provider-accounts.tsx";
import type { ProviderAccountsSnapshot, ProviderSignIn } from "../shared/provider-accounts.ts";

const pending = (operation: ProviderSignIn) => ["starting", "waiting", "saving"].includes(operation.state);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function DotAccounts({ computer, online, account, accountName, identity, ready, busy, connect, disconnect }: {
	computer?: string; online: boolean; account?: string; accountName?: string; identity?: string; ready: boolean; busy: boolean;
	connect: (id: string) => Promise<void>; disconnect: () => Promise<void>;
}) {
	const [snapshot, setSnapshot] = useState<ProviderAccountsSnapshot>();
	const [choice, setChoice] = useState(account ?? ""), [name, setName] = useState("");
	const [error, setError] = useState(""), [readError, setReadError] = useState(""), [working, setWorking] = useState(false);
	const [admission, setAdmission] = useState<string>();
	const live = useRef(true), lock = useRef(false), sequence = useRef(0);
	useEffect(() => { setChoice(account ?? ""); }, [account]);
	const refresh = async () => {
		const request = ++sequence.current;
		try {
			const value = await api<ProviderAccountsSnapshot>("/provider-accounts", undefined, computer);
			if (live.current && sequence.current === request) { setSnapshot(value); setReadError(""); }
		} catch (error) { if (live.current && sequence.current === request) setReadError(errorText(error)); }
	};
	const following = !!admission || !!snapshot?.signIns.some(pending);
	useEffect(() => {
		live.current = true; let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(poll, following ? 1500 : 15_000); };
		if (online) void poll();
		return () => { live.current = false; stopped = true; clearTimeout(timer); };
	}, [computer, online, following]);
	const known = snapshot?.signIns.find(operation => operation.id === admission);
	useEffect(() => {
		if (known && !pending(known)) {
			if (known.state === "completed") { setChoice(known.account ?? known.id); setName(""); }
			else if (known.error) setError(known.error);
			setAdmission(undefined);
		}
	}, [known?.id, known?.state]);
	const run = async (work: () => Promise<unknown>) => {
		if (lock.current) return;
		lock.current = true; sequence.current++; setWorking(true); setError("");
		try { await work(); } catch (error) { if (live.current) setError(errorText(error)); }
		finally { await refresh(); lock.current = false; if (live.current) setWorking(false); }
	};
	const accounts = snapshot?.accounts.filter(item => item.provider === "openai-codex" && !item.native) ?? [];
	const current = snapshot?.signIns.find(pending), unconfirmed = admission && !known;
	const disabled = !online || busy || working;
	const signIn = current && <SignIn operation={current} disabled={disabled}
		cancel={() => run(async () => { await api(`/provider-accounts/sign-ins/${current.id}/cancel`, {}, computer); if (live.current && admission === current.id) setAdmission(undefined); })}
		answer={(prompt, value) => run(() => api(`/provider-accounts/sign-ins/${current.id}/answer`, { prompt, value }, computer))} />;
	return <div className="dot-account-settings">
		<label>ChatGPT account<select aria-label="Dot ChatGPT account" value={choice} disabled={disabled || !snapshot} onChange={event => setChoice(event.target.value)}>
			<option value="">Choose the account that owns your Dot</option>
			{choice && !accounts.some(item => item.id === choice) && <option value={choice}>{snapshot ? "Saved account unavailable" : accountName ?? "Loading saved account…"}</option>}
			{accounts.map(item => <option key={item.id} value={item.id}>{item.name}{item.identity ? ` · ${item.identity}` : ""}</option>)}
		</select></label>
		{(error || readError) && <p className="error-text" role="alert">{error || readError}</p>}
		<div className="dot-connection-actions">
			<button className="primary" disabled={disabled || !accounts.some(item => item.id === choice)} onClick={() => void connect(choice)}>
				{busy ? "Connecting…" : ready && choice !== account ? "Switch account" : ready ? "Reconnect Dot" : "Connect Dot"}
			</button>
			{account && <button disabled={disabled} onClick={() => void disconnect()}>Disconnect</button>}
			<button className="quiet-action" disabled={disabled} onClick={() => void refresh()}>Refresh accounts</button>
		</div>
		{ready && <p>Connected using <strong>{identity ?? accountName ?? "your selected account"}</strong>.</p>}
		<p className="muted">Messages and files use this saved sign-in. Your agents keep their own accounts.</p>
		{ready && <p className="muted">Disconnecting Desk does not pause your hosted Dot.</p>}
		{current?.provider === "openai-codex" ? signIn : current && <details><summary>Another provider sign-in is in progress</summary>{signIn}</details>}
		{unconfirmed && <div role="status"><p>Checking whether sign-in started. This attempt will not be submitted again.</p>
			<button disabled={disabled} onClick={() => void run(async () => { await api(`/provider-accounts/sign-ins/${admission}/cancel`, {}, computer); if (live.current) setAdmission(undefined); })}>Cancel this attempt</button></div>}
		{!current && !admission && <details className="dot-add-account"><summary>Add a ChatGPT account</summary>
			<form className="provider-account-add" onSubmit={event => {
				event.preventDefault(); if (disabled || lock.current || !name.trim()) return;
				const request = { id: crypto.randomUUID(), provider: "openai-codex", name: name.trim(), type: "oauth" };
				setAdmission(request.id);
				void run(async () => {
					const receipt = await api<ProviderSignIn>("/provider-accounts/sign-ins", request, computer);
					if (live.current) setSnapshot(previous => ({ defaults: previous?.defaults ?? {}, accounts: previous?.accounts ?? [], providers: previous?.providers ?? [],
						signIns: [receipt, ...(previous?.signIns.filter(item => item.id !== receipt.id) ?? [])] }));
				});
			}}>
				<label>Account label<input aria-label="Dot account label" value={name} maxLength={100} disabled={disabled} placeholder="For example, Personal" onChange={event => setName(event.target.value)} /></label>
				<button type="submit" disabled={disabled || !name.trim()}>Sign in</button>
			</form>
			<p className="muted">Complete verification with the provider, then choose the saved account above.</p>
		</details>}
	</div>;
}
