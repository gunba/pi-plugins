import { Icon } from "./icons.tsx";
import { useAnchoredPopover } from "./anchored-popover.ts";
import type { Delivery } from "./composer-keys.ts";

export const deliveryModes: { value: Delivery; label: string; icon: string; description: string }[] = [
	{ value: "steer", label: "Steer", icon: "steer", description: "Deliver at the next safe point." },
	{ value: "followUp", label: "Queue", icon: "queue", description: "Deliver after the current response." },
	{ value: "now", label: "Send now", icon: "send-now", description: "Stop the current turn and send immediately." },
];
export function DeliveryControl({ value, choose, send, disabled, canSendNow, busy, scope }: {
	value: Delivery; choose: (value: Delivery) => void; send: (value: Delivery) => void;
	disabled: boolean; canSendNow: boolean; busy: boolean; scope: string;
}) {
	const menu = useAnchoredPopover(scope, false, 290);
	const selected = deliveryModes.find(mode => mode.value === value)!;
	const unavailable = value === "now" && !canSendNow;
	return <div className="delivery-control">
		<button type="button" className="send-button" disabled={disabled || unavailable}
			aria-label={busy ? selected.label : "Send message"}
			title={unavailable ? "Send now is not available for this worker" : `${selected.label} · Enter · Alt-click queues a follow-up`}
			onClick={event => send(event.altKey || event.shiftKey ? "followUp" : value)}>
			<Icon name={busy || value !== "steer" ? selected.icon : "send"} />
		</button>
		<button type="button" ref={menu.trigger} className="delivery-choice" popoverTarget={menu.id}
			aria-label={`Send mode: ${selected.label}`} title="Choose the default for Enter and the send button" aria-haspopup="menu" aria-expanded={menu.open}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
		</button>
		<div ref={menu.panel} id={menu.id} popover="auto" className="delivery-menu" role="menu" aria-label="Default send mode"
			onBeforeToggle={menu.beforeToggle} onToggle={menu.toggle} onKeyDown={event => {
				menu.keyDown(event); if (event.defaultPrevented) return;
				if (event.key === "Tab") { menu.close(); return; }
				if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
				const index = options.indexOf(document.activeElement as HTMLButtonElement);
				const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
				options[next]?.focus({ preventScroll: true });
			}}>
			<div className="delivery-menu-title">Enter &amp; send button<small>Saved in this browser</small></div>
			{deliveryModes.map(mode => <button type="button" role="menuitemradio" aria-checked={mode.value === value} key={mode.value}
				disabled={mode.value === "now" && !canSendNow} tabIndex={-1}
				data-autofocus={mode.value === (unavailable ? "steer" : value) ? true : undefined}
				onClick={() => { menu.close(); choose(mode.value); }}>
				<Icon name={mode.icon} /><span><strong>{mode.label}</strong><small>{mode.value === "now" && !canSendNow ? "Not available for this worker." : mode.description}</small></span>
				{mode.value === value && <Icon name="check" />}
			</button>)}
		</div>
	</div>;
}
