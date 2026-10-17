import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ProviderAccountsSnapshot, ProviderSignIn, ProviderAuthType } from "../shared/provider-accounts.ts";
import type { SessionView, WorkerCommand } from "../shared/protocol.ts";
import type { Computer, WorkspaceState } from "./workspace.ts";
import { api } from "./connection.ts";
import { Icon } from "./icons.tsx";
import { Row } from "./settings-pages.tsx";

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
		{computers && !computer && <label className="setting-control">Computer<select aria-label="Model account computer" value={id ?? ""} onChange={event => setChosen(event.target.value)}>
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
	const option = (account: { id: string; name: string; identity?: string }) => <option key={account.id} value={account.id}>{account.name}{account.identity && account.identity !== account.name ? ` · ${account.identity}` : ""}</option>;
	const locked = working || !!current || !!admission;
	return <section className="settings-group">
		{(snapshot?.providers.length ?? 0) > 1 && <Row label="Provider">
			<select aria-label="Model account provider" value={providerId} disabled={working} onChange={event => { setProvider(event.target.value); setMethod("oauth"); }}>
				{!provider && <option value={providerId}>{providerName}</option>}
				{snapshot?.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
			</select>
			<button className="icon-button" aria-label="Refresh accounts" title="Refresh accounts" disabled={!connected || working} onClick={() => void refresh()}><Icon name="refresh" /></button>
		</Row>}
		{(readError || error || !connected) && <Row label=""><span className={readError || error ? "error-text" : "muted"} role="alert">{error || readError || `${computerName} is disconnected.`}</span></Row>}
		{session && <Row label="This conversation" hint={idle ? "Each conversation keeps its own account; its subagents use the same one." : "You can change the account when the conversation and its queued work are idle."}>
			<select aria-label="Conversation provider account" value={changing ? "" : selected ?? ""}
				disabled={!connected || !snapshot || selected === undefined || !idle || busy || working || changing} onChange={event => {
					const id = event.target.value; setSelecting(true);
					void run(() => invoke({ kind: "account", provider: providerId, id })).finally(() => { if (alive.current) setSelecting(false); });
				}}>
				{(changing || selected === undefined) && <option value="">{changing ? "Changing account…" : "Account selection unavailable"}</option>}
				{!accounts.some(account => account.id === "pi") && <option value="pi">Pi's own sign-in</option>}
				{selected && selected !== "pi" && !accounts.some(account => account.id === selected) && <option value={selected}>{snapshot ? "Saved account missing" : "Saved account"}</option>}
				{accounts.map(option)}
			</select>
			{!idle && session.state !== "closed" && <span className="muted">change when idle</span>}
		</Row>}
		{!snapshot ? <Row label="Accounts"><span className="muted">{connected && !readError ? "Loading…" : "Unavailable"}</span></Row> : <>
			{lastChange && ["failed", "interrupted"].includes(lastChange.state) && <Row label=""><span className="error-text" role="alert">The last account change {lastChange.state}: {lastChange.error ?? "check the selection before trying again."}</span></Row>}
			<Row label="New conversations" hint={`The account new conversations on ${computerName} start with. Existing conversations keep theirs.`}>
				<select aria-label="Default provider account" value={snapshot.defaults[providerId] ?? "pi"} disabled={!connected || working} onChange={event => {
					const id = event.target.value;
					void run(async () => { const value = await api<ProviderAccountsSnapshot>("/provider-accounts/default", { provider: providerId, id }, computer); if (alive.current) setSnapshot(value); });
				}}>
					{!accounts.some(account => account.id === "pi") && <option value="pi">Pi's own sign-in</option>}
					{snapshot.defaults[providerId] && snapshot.defaults[providerId] !== "pi" && !accounts.some(account => account.id === snapshot.defaults[providerId]) && <option value={snapshot.defaults[providerId]}>Saved account missing</option>}
					{accounts.map(option)}
				</select>
			</Row>
			<Row label="Add an account" hint={type === "oauth" ? `Opens ${providerName}'s sign-in page; it works from any device. Adding an account doesn't switch any conversation.` : "Adding an account doesn't switch any conversation."}>
				{!provider ? <span className="muted">{providerName} has no sign-in Desk can run.</span> : <form className="settings-inline-form" onSubmit={start}>
					{provider.types.length > 1 && <select aria-label="Provider sign-in method" value={type} disabled={locked} onChange={event => setMethod(event.target.value as ProviderAuthType)}>
						{provider.types.map(type => <option key={type} value={type}>{type === "oauth" ? provider.subscription ? "Subscription" : "Sign in" : "API key"}</option>)}
					</select>}
					<input aria-label="Provider account name" maxLength={100} value={name} placeholder="Name it, e.g. Work" disabled={locked} onChange={event => setName(event.target.value)} />
					<button type="submit" disabled={!connected || !type || locked || !name.trim()}>Sign in</button>
				</form>}
			</Row>
		</>}
		{unconfirmed && <Row label="Signing in"><span className="muted">Checking {admission.name}…</span>
			<button className="quiet-action" disabled={!connected || working} onClick={() => void refresh()}>Check</button>
			<button className="quiet-action" disabled={!connected || working} onClick={() => void cancel(admission.id)}>Cancel</button></Row>}
		{current && <div className="settings-row settings-row-wide"><SignIn operation={current} disabled={!connected || working}
			cancel={() => cancel(current.id)} answer={(prompt, value) => run(() => api(`/provider-accounts/sign-ins/${current.id}/answer`, { prompt, value }, computer))} /></div>}
		{!!snapshot?.signIns.filter(operation => !pending(operation)).length && <details className="settings-disclosure provider-sign-in-history"><summary>Recent sign-ins</summary>
			{snapshot.signIns.filter(operation => !pending(operation)).slice(0, 5).map(operation => <div key={operation.id}>
				<strong>{operation.name || "Sign-in"}</strong><span>{operation.state}</span>
				{operation.message && <p>{operation.message}</p>}{operation.error && <p className="error-text">{operation.error}</p>}
			</div>)}
		</details>}
	</section>;
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
