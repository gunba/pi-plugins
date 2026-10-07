import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ProviderAccountsSnapshot, ProviderSignIn, ProviderAuthType } from "../shared/provider-accounts.ts";
import type { SessionView, WorkerCommand } from "../shared/protocol.ts";
import type { Computer, WorkspaceState } from "./workspace.ts";
import { api } from "./connection.ts";
import { Icon } from "./icons.tsx";

const pending = (operation: ProviderSignIn) => ["starting", "waiting", "saving"].includes(operation.state);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ProviderAccountsPanel({ host, computer, session, connected, busy, invoke, providerHint }: {
	host: WorkspaceState; computer?: Computer; session?: SessionView; connected: boolean; busy: boolean; providerHint?: string;
	invoke: (command: WorkerCommand) => Promise<unknown>;
}) {
	const [chosen, setChosen] = useState("");
	const computers = host.computers;
	const id = chosen || computer?.id || computers?.find(item => item.connected)?.id || computers?.[0]?.id;
	const target = computers?.find(item => item.id === id);
	return <>
		{computers && <label className="setting-control">Computer<select aria-label="Model account computer" value={id ?? ""} onChange={event => setChosen(event.target.value)}>
			{!computers.length && <option value="">No computers</option>}
			{computers.map(item => <option key={item.id} value={item.id}>{item.name}{item.connected ? "" : " — disconnected"}</option>)}
		</select></label>}
		{(!computers || id) && <AccountStore key={id ?? "local"} computer={id} name={target?.name ?? host.name}
			connected={computers ? !!target?.connected : connected} session={!computers || computer?.id === id ? session : undefined}
			busy={busy} invoke={invoke} providerHint={providerHint} />}
	</>;
}

function AccountStore({ computer, name: computerName, connected, session, busy, invoke, providerHint }: {
	computer?: string; name: string; connected: boolean; session?: SessionView; busy: boolean; providerHint?: string;
	invoke: (command: WorkerCommand) => Promise<unknown>;
}) {
	const [snapshot, setSnapshot] = useState<ProviderAccountsSnapshot>();
	const [name, setName] = useState("");
	const [providerChoice, setProvider] = useState(providerHint ?? "");
	useEffect(() => { setProvider(providerHint ?? ""); }, [providerHint]);
	const [method, setMethod] = useState<ProviderAuthType>("oauth");
	const [error, setError] = useState("");
	const [readError, setReadError] = useState("");
	const [admission, setAdmission] = useState<{ id: string; name: string }>();
	const [working, setWorking] = useState(false), [selecting, setSelecting] = useState(false);
	const lock = useRef(false), alive = useRef(true);
	const refresh = async () => {
		try {
			const value = await api<ProviderAccountsSnapshot>("/provider-accounts", undefined, computer);
			if (alive.current) { setSnapshot(value); setReadError(""); }
		} catch (error) { if (alive.current) setReadError(message(error)); }
	};
	const followingSignIn = !!admission || !!snapshot?.signIns.some(pending);
	useEffect(() => {
		alive.current = true; let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
		const poll = async () => {
			await refresh();
			if (!stopped) timer = setTimeout(poll, followingSignIn ? 1500 : 15_000);
		};
		if (connected) void poll();
		return () => { stopped = true; alive.current = false; clearTimeout(timer); };
	}, [computer, connected, followingSignIn]);
	const known = snapshot?.signIns.find(operation => operation.id === admission?.id);
	useEffect(() => { if (known && !pending(known)) setAdmission(undefined); }, [known?.id, known?.state]);
	const providerId = providerChoice || session?.snapshot?.model?.provider || "openai-codex";
	const provider = snapshot?.providers.find(item => item.id === providerId);
	const providerName = provider?.name ?? providerId;
	const type = provider?.types.includes(method) ? method : provider?.types[0];
	const current = snapshot?.signIns.find(pending);
	const unconfirmed = admission && !known;
	const run = async (operation: () => Promise<unknown>) => {
		if (lock.current) return;
		lock.current = true; setWorking(true); setError("");
		try { await operation(); }
		catch (error) { if (alive.current) setError(message(error)); }
		finally { await refresh(); lock.current = false; if (alive.current) setWorking(false); }
	};
	const start = (event: FormEvent) => {
		event.preventDefault();
		if (lock.current || current || admission || !type || !name.trim()) return;
		const request = { id: crypto.randomUUID(), provider: providerId, type, name: name.trim() };
		setAdmission(request);
		void run(async () => {
			const receipt = await api<ProviderSignIn>("/provider-accounts/sign-ins", request, computer);
			if (alive.current) { setName(""); setSnapshot(previous => ({ defaults: previous?.defaults ?? {}, providers: previous?.providers ?? [], accounts: previous?.accounts ?? [], signIns: [receipt, ...previous?.signIns.filter(item => item.id !== receipt.id) ?? []] })); }
		});
	};
	const cancel = (id: string) => run(async () => {
		await api(`/provider-accounts/sign-ins/${id}/cancel`, {}, computer);
		if (alive.current && admission?.id === id) setAdmission(undefined);
	});
	const selected = session?.snapshot?.accounts ? session.snapshot.accounts[providerId] ?? "pi" : undefined;
	const changing = selecting || session?.controls?.some(control => control.kind === "account" && control.state === "running");
	const accounts = snapshot?.accounts.filter(account => account.provider === providerId) ?? [];
	const lastChange = session?.controls?.find(control => control.kind === "account");
	const idle = session?.state === "ready" && session.snapshot?.activity !== "running" && session.snapshot?.activity !== "waiting"
		&& !session.snapshot?.queue.steering.count && !session.snapshot?.queue.followUp.count;
	return <>
		<section className="panel-card"><h3><Icon name="account" />Model accounts</h3>
			<label className="setting-control">Provider<select aria-label="Model account provider" value={providerId} disabled={working}
				onChange={event => { setProvider(event.target.value); setMethod("oauth"); }}>
				{!provider && <option value={providerId}>{providerName}</option>}
				{snapshot?.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
			</select></label>
			<p className="muted">Accounts are saved on {computerName}. Each conversation chooses its own account.</p>
			{!connected && <p className="muted">This computer is disconnected.</p>}
			{readError && <p className="error-text" role="alert">{readError}</p>}
			{error && <p className="error-text" role="alert">{error}</p>}
			{!snapshot ? <p className="muted">{readError ? "Saved accounts could not be loaded. Refresh accounts to check again." : connected ? "Loading saved accounts…" : "Connect to view saved accounts."}</p>
				: accounts.length ? <ul className="provider-account-list">{accounts.map(account => <li key={account.id}>
					<div><strong>{account.name}</strong>{account.identity && <small>{account.identity}</small>}</div>
					{session && account.id === selected && <span className="muted">This conversation</span>}
				</li>)}</ul> : <p className="muted">No accounts saved for {providerName}.</p>}
			<label className="setting-control">Default for new conversations<select aria-label="Default provider account" value={snapshot ? snapshot.defaults[providerId] ?? "pi" : ""}
				disabled={!connected || !snapshot || working} onChange={event => {
					const id = event.target.value;
					void run(async () => { const value = await api<ProviderAccountsSnapshot>("/provider-accounts/default", { provider: providerId, id }, computer); if (alive.current) setSnapshot(value); });
				}}>
				{!snapshot && <option value="">{connected ? "Loading computer default…" : "Connect to view the computer default"}</option>}
				{!accounts.some(account => account.id === "pi") && <option value="pi">Default Pi credentials</option>}
				{snapshot?.defaults[providerId] && snapshot.defaults[providerId] !== "pi" && !accounts.some(account => account.id === snapshot.defaults[providerId]) && <option value={snapshot.defaults[providerId]}>Saved default unavailable</option>}
				{accounts.map(account => <option key={account.id} value={account.id}>{account.name}{account.identity ? ` · ${account.identity}` : ""}</option>)}
			</select></label>
			<p className="muted">Applies to new conversations on {computerName}. Existing conversations and their subagents keep their saved accounts.</p>
			{session ? <label className="setting-control">{connected ? "Conversation account" : "Last confirmed account"}<select aria-label="Conversation provider account" value={changing ? "" : selected ?? ""}
				disabled={!connected || !snapshot || selected === undefined || !idle || busy || working || changing} onChange={event => {
					const id = event.target.value; setSelecting(true);
					void run(() => invoke({ kind: "account", provider: providerId, id })).finally(() => { if (alive.current) setSelecting(false); });
				}}>
				{(changing || selected === undefined) && <option value="">{changing ? "Changing account…" : "Account selection unavailable"}</option>}
				{!accounts.some(account => account.id === "pi") && <option value="pi">Default Pi credentials</option>}
				{selected && selected !== "pi" && !accounts.some(account => account.id === selected) && <option value={selected}>{snapshot ? "Saved account unavailable" : "Selected saved account · loading details"}</option>}
				{accounts.map(account => <option key={account.id} value={account.id}>{account.name}{account.identity ? ` · ${account.identity}` : ""}</option>)}
			</select></label> : <p className="muted">Select a conversation on this computer to choose its account.</p>}
			{lastChange && ["failed", "interrupted"].includes(lastChange.state) && <p className="error-text" role="alert">Last account change {lastChange.state}: {lastChange.error ?? "Check the current selection before trying again."}</p>}
			{session && !idle && <p className="muted">{session.state === "closed" ? "This conversation is closed. Changing the computer default does not change its saved account." : "Account changes are available when the conversation and its queued work are idle."}</p>}
			<button className="quiet-action" disabled={!connected || working} onClick={() => void refresh()}><Icon name="refresh" />Refresh accounts</button>
		</section>
		<section className="panel-card provider-sign-in"><h3><Icon name="login" />Add account</h3>
			<p className="muted">Adding an account does not switch or start any conversation.</p>
			{provider?.types.length && provider.types.length > 1 ? <label className="setting-control">Sign-in method<select aria-label="Provider sign-in method" value={type} disabled={working || !!current || !!admission} onChange={event => setMethod(event.target.value as ProviderAuthType)}>
				{provider.types.map(type => <option key={type} value={type}>{type === "oauth" ? provider.subscription ? "Subscription sign-in" : "Account sign-in" : "API key"}</option>)}
			</select></label> : null}
			{type === "oauth" && <p className="muted">Sign in on {providerName}’s page from any computer. Use the verification code or paste the returned authorization code here when prompted.</p>}
			{!provider && snapshot && <p className="muted">This provider has no supported sign-in method in the host account manager.</p>}
			<form className="provider-account-add" onSubmit={start}>
				<label>Account name<input aria-label="Provider account name" maxLength={100} value={name} placeholder="Account name" disabled={working || !!current || !!admission} onChange={event => setName(event.target.value)} /></label>
				<button type="submit" disabled={!connected || !snapshot || !type || working || !!current || !!admission || !name.trim()}>Sign in</button>
			</form>
			{unconfirmed && <div className="provider-sign-in-status" role="status"><p>Checking sign-in admission for {admission.name}. No new sign-in will be started.</p>
				<button disabled={!connected || working} onClick={() => void refresh()}>Check status</button>
				<button disabled={!connected || working} onClick={() => void cancel(admission.id)}>Cancel attempt</button>
			</div>}
			{current && <SignIn operation={current} disabled={!connected || working}
				cancel={() => cancel(current.id)} answer={(prompt, value) => run(() => api(`/provider-accounts/sign-ins/${current.id}/answer`, { prompt, value }, computer))} />}
			{!!snapshot?.signIns.filter(operation => !pending(operation)).length && <details className="provider-sign-in-history"><summary>Recent sign-ins</summary>
				{snapshot.signIns.filter(operation => !pending(operation)).slice(0, 5).map(operation => <div key={operation.id}>
					<strong>{operation.name || "Sign-in"}</strong><span>{operation.state}</span>
					{operation.message && <p>{operation.message}</p>}{operation.error && <p className="error-text">{operation.error}</p>}
				</div>)}
			</details>}
		</section>
	</>;
}
export function SignIn({ operation, disabled, cancel, answer }: { operation: ProviderSignIn; disabled: boolean;
	cancel: () => Promise<unknown>; answer: (prompt: string, value: string) => Promise<unknown>;
}) {
	const [copyError, setCopyError] = useState("");
	return <div className="provider-sign-in-status" role="status">
		<strong>{operation.name}</strong><p>{operation.message ?? "Waiting for provider sign-in…"}</p>
		{operation.device && <div className="provider-device-code"><code>{operation.device.code}</code>
			<button className="quiet-action" onClick={() => { void navigator.clipboard.writeText(operation.device!.code).catch(error => setCopyError(message(error))); }}>Copy code</button>
			{operation.device.expires && <small>Expires {new Date(operation.device.expires).toLocaleTimeString()}</small>}
		</div>}
		{operation.links?.map(link => <a className="quiet-action" key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label} ↗</a>)}
		{copyError && <p className="error-text" role="alert">{copyError}</p>}
		{operation.prompt && <SignInPrompt key={operation.prompt.id} prompt={operation.prompt} disabled={disabled} answer={answer} />}
		<button disabled={disabled} onClick={() => void cancel()}>Cancel sign-in</button>
	</div>;
}
function SignInPrompt({ prompt, disabled, answer }: { prompt: NonNullable<ProviderSignIn["prompt"]>; disabled: boolean;
	answer: (prompt: string, value: string) => Promise<unknown>;
}) {
	const [value, setValue] = useState(prompt.kind === "select" ? prompt.options?.[0]?.id ?? "" : "");
	return <form className="provider-account-add" onSubmit={event => { event.preventDefault(); void answer(prompt.id, value); }}>
		<label>{prompt.message}{prompt.kind === "select" ? <select value={value} disabled={disabled} onChange={event => setValue(event.target.value)}>
			{prompt.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
		</select> : <input type={prompt.kind === "secret" ? "password" : "text"} autoComplete="off" value={value} disabled={disabled} placeholder={prompt.placeholder} onChange={event => setValue(event.target.value)} />}</label>
		<button type="submit" disabled={disabled || !value.trim()}>Continue sign-in</button>
	</form>;
}
