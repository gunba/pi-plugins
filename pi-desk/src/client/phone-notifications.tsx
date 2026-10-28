import { useEffect, useState } from "react";
import type { BrowserAccount } from "./account.ts";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
const bytes = (key: string) => Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const same = (a: ArrayBuffer | null, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((value, index) => value === b[index]);

/** Subscribes this browser to the workspace's notifications (account push.ts), replacing one made with an older key. */
async function subscribe(account: BrowserAccount): Promise<PushSubscription> {
	if (await Notification.requestPermission() !== "granted") throw new Error("Notifications are blocked for Desk in this browser's settings.");
	const registration = await navigator.serviceWorker.ready, key = bytes(await account.pushKey());
	const current = await registration.pushManager.getSubscription();
	if (current && same(current.options.applicationServerKey, key)) return current;
	await current?.unsubscribe();
	return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/** Settings row: whether this device gets notifications while you're away, and turning them on or off. */
export function PhoneNotifications({ account }: { account?: BrowserAccount }) {
	const [on, setOn] = useState<boolean>(), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
	useEffect(() => {
		if (!account || !supported()) return;
		void navigator.serviceWorker.ready.then(registration => registration.pushManager.getSubscription()).then(value => setOn(!!value && Notification.permission === "granted"));
	}, [account]);
	if (!account) return <span className="muted">Open Desk from your account's web address on this device to get notifications.</span>;
	if (!supported()) return <span className="muted">This browser can't receive notifications. On an iPhone, add Desk to the Home Screen and open it from there.</span>;
	const run = (job: () => Promise<string>) => { setBusy(true); setMessage(""); void job().then(setMessage, error => setMessage(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false)); };
	const enable = (test: boolean) => run(async () => {
		const subscription = await subscribe(account), result = await account.push(subscription.toJSON(), test);
		setOn(result.subscribed);
		return test ? (result.sent ? "Sent a test notification." : "The test notification could not be delivered.") : "This device gets notifications.";
	});
	return <>
		<span className="muted">{on ? "This device gets them." : "This device doesn't get them."}</span>
		{on ? <>
			<button className="quiet-action" disabled={busy} onClick={() => enable(true)}>Send a test</button>
			<button className="quiet-action" disabled={busy} onClick={() => run(async () => {
				const registration = await navigator.serviceWorker.ready;
				await (await registration.pushManager.getSubscription())?.unsubscribe();
				await account.push(null); setOn(false); return "This device no longer gets notifications.";
			})}>Turn off</button>
		</> : <button className="quiet-action" disabled={busy} onClick={() => enable(true)}>Send notifications here</button>}
		{message && <span className="muted" role="status">{message}</span>}
	</>;
}
