import { useEffect, useRef, useState } from "react";
import type { LoginsSnapshot, ProviderAuthType, SignIn } from "../shared/logins.ts";
import { api } from "./connection.ts";
import { Row } from "./settings-pages.tsx";

const pending = (operation: SignIn) => ["starting", "waiting"].includes(operation.state);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Pi's own logins on one computer: one per provider, shared by every conversation there and by terminal Pi. */
export function LoginsPanel({ computer, connected, provider: hint }: { computer?: string; connected: boolean; provider?: string }) {
	const [snapshot, setSnapshot] = useState<LoginsSnapshot>();
	const [choice, setChoice] = useState(hint ?? ""), [method, setMethod] = useState<ProviderAuthType>("oauth");
	const [error, setError] = useState(""), [working, setWorking] = useState(false), [started, setStarted] = useState<string>();
	const alive = useRef(true);
	useEffect(() => { if (hint) setChoice(hint); }, [hint]);
	const refresh = async () => {
		try { const value = await api<LoginsSnapshot>("/logins", undefined, computer); if (alive.current) { setSnapshot(value); setError(""); } }
		catch (failure) { if (alive.current) setError(message(failure)); }
	};
	const current = snapshot?.signIns.find(pending);
	useEffect(() => {
		alive.current = true; let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
		const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(poll, current || started ? 1500 : 30_000); };
		if (connected) void poll();
		return () => { stopped = true; alive.current = false; clearTimeout(timer); };
	}, [computer, connected, !!current || !!started]);
	const finished = snapshot?.signIns.find(operation => operation.id === started && !pending(operation));
	useEffect(() => { if (finished) { if (finished.state === "failed") setError(finished.error ?? "Sign-in failed."); setStarted(undefined); } }, [finished?.id, finished?.state]);
	const run = async (work: () => Promise<unknown>) => {
		if (working) return;
		setWorking(true); setError("");
		try { await work(); } catch (failure) { if (alive.current) setError(message(failure)); }
		finally { await refresh(); if (alive.current) setWorking(false); }
	};
	const signIn = (provider: string, type: ProviderAuthType) => run(async () => {
		const id = crypto.randomUUID(); setStarted(id);
		await api("/logins/sign-ins", { id, provider, type }, computer);
	});
	const signedIn = snapshot?.providers.filter(provider => provider.signedIn) ?? [];
	const others = snapshot?.providers.filter(provider => !provider.signedIn) ?? [];
	const chosen = snapshot?.providers.find(provider => provider.id === choice) ?? others[0];
	const type = chosen?.types.includes(method) ? method : chosen?.types[0];
	const locked = !connected || working || !!current || !!started;
	return <section className="settings-group">
		{!snapshot ? <Row label="Logins"><span className="muted">{!connected ? "Disconnected" : error || "Loading…"}</span></Row> : <>
			{signedIn.map(provider => <Row key={provider.id} label={provider.name}
				hint="Every conversation on this computer, and terminal Pi, uses this login.">
				<span className="grow">{provider.signedIn!.identity?.replace(/ · Account [0-9a-f-]{36}$/, "") ?? (provider.signedIn!.type === "api_key" ? "API key" : "Signed in")}</span>
				{provider.types.includes(provider.signedIn!.type) && <button className="quiet-action" disabled={locked} onClick={() => void signIn(provider.id, provider.signedIn!.type)}>{provider.signedIn!.type === "api_key" ? "Replace API key" : "Sign in again"}</button>}
				<button className="quiet-action" disabled={locked} onClick={() => void run(() => api("/logins/sign-out", { provider: provider.id }, computer))}>{provider.signedIn!.type === "api_key" ? "Remove API key" : "Sign out"}</button>
			</Row>)}
			{!!others.length && <Row label={signedIn.length ? "Another provider" : "Add provider"}>
				<form className="settings-inline-form" onSubmit={event => { event.preventDefault(); if (chosen && type) void signIn(chosen.id, type); }}>
					<select aria-label="Provider" value={chosen?.id ?? ""} disabled={locked} onChange={event => { setChoice(event.target.value); setMethod("oauth"); }}>
						{others.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
					</select>
					{chosen && chosen.types.length > 1 && <select aria-label="Sign-in method" value={type} disabled={locked} onChange={event => setMethod(event.target.value as ProviderAuthType)}>
						{chosen.types.map(item => <option key={item} value={item}>{item === "oauth" ? chosen.subscription ? "Subscription" : "Sign in" : "API key"}</option>)}
					</select>}
					<button type="submit" disabled={locked || !type}>{type === "api_key" ? "Add API key" : "Sign in"}</button>
				</form>
			</Row>}
		</>}
		{error && snapshot && <Row label=""><span className="error-text" role="alert">{error}</span></Row>}
		{current && <div className="settings-row settings-row-wide"><SignInProgress operation={current} disabled={!connected || working}
			cancel={() => run(() => api(`/logins/sign-ins/${current.id}/cancel`, {}, computer))}
			answer={(prompt, value) => run(() => api(`/logins/sign-ins/${current.id}/answer`, { prompt, value }, computer))} /></div>}
	</section>;
}

/** A provider's sign-in while it runs: its code, links and any question it asks. */
export function SignInProgress({ operation, disabled, cancel, answer }: { operation: SignIn; disabled: boolean;
	cancel: () => Promise<unknown>; answer: (prompt: string, value: string) => Promise<unknown>;
}) {
	const [copyError, setCopyError] = useState("");
	return <div className="provider-sign-in-status" role="status">
		<p>{operation.message ?? "Waiting for the provider…"}</p>
		{operation.device && <div className="provider-device-code"><code>{operation.device.code}</code>
			<button className="quiet-action" onClick={() => { void navigator.clipboard.writeText(operation.device!.code).catch(error => setCopyError(message(error))); }}>Copy code</button>
			{operation.device.expires && <small>Expires {new Date(operation.device.expires).toLocaleTimeString()}</small>}
		</div>}
		{operation.links?.map(link => <a className="quiet-action" key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label} ↗</a>)}
		{copyError && <p className="error-text" role="alert">{copyError}</p>}
		{operation.prompt && <SignInPrompt key={operation.prompt.id} prompt={operation.prompt} apiKey={operation.type === "api_key"} disabled={disabled} answer={answer} />}
		<button disabled={disabled} onClick={() => void cancel()}>{operation.type === "api_key" ? "Cancel key entry" : "Cancel sign-in"}</button>
	</div>;
}
function SignInPrompt({ prompt, disabled, answer, apiKey }: { prompt: NonNullable<SignIn["prompt"]>; disabled: boolean; apiKey: boolean;
	answer: (prompt: string, value: string) => Promise<unknown>;
}) {
	const [value, setValue] = useState(prompt.kind === "select" ? prompt.options?.[0]?.id ?? "" : "");
	return <form className="settings-inline-form" onSubmit={event => { event.preventDefault(); void answer(prompt.id, value); }}>
		<label className="grow">{prompt.message}{prompt.kind === "select" ? <select value={value} disabled={disabled} onChange={event => setValue(event.target.value)}>
			{prompt.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
		</select> : <input type={prompt.kind === "secret" ? "password" : "text"} autoComplete="off" value={value} disabled={disabled} placeholder={prompt.placeholder} onChange={event => setValue(event.target.value)} />}</label>
		<button type="submit" disabled={disabled || !value.trim()}>{apiKey ? "Save API key" : "Continue"}</button>
	</form>;
}
