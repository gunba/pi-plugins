import { useState } from "react";
import type { Ledger, LedgerGroup } from "../../../pi-context-ledger/model.ts";

const tokens = (value: number) => Math.round(value).toLocaleString();

function Group({ group, total }: { group: LedgerGroup; total: number }) {
	const [open, setOpen] = useState(false);
	return <details className="ledger-group" onToggle={event => setOpen(event.currentTarget.open)}>
		<summary>
			<span>{group.label}</span><strong>{tokens(group.tokens)}</strong>
			<progress value={group.tokens} max={Math.max(1, total)} aria-label={`${group.label} estimated tokens`} />
		</summary>
		{open && <>
			{group.note && <p className="muted">{group.note}</p>}
			<ul>{group.items.map((item, index) => <li key={index}><span>{item.label}</span><span>{tokens(item.tokens)}</span></li>)}</ul>
		</>}
	</details>;
}

export function LedgerCard({ ledger, expanded = false }: { ledger: Ledger; expanded?: boolean }) {
	const [open, setOpen] = useState(expanded);
	return <details className="ledger-card" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
		<summary><strong>Initial context</strong><span>~{tokens(ledger.total)} tokens</span></summary>
		{open && <div className="ledger-content">
			<p className="muted">Instruction, tool and first-message estimates, not current conversation usage.
				{ledger.windowPercent !== null && ` ${ledger.windowPercent.toFixed(1)}% of the ${tokens(ledger.contextWindow)}-token window.`}</p>
			{ledger.groups.map((group, index) => <Group key={index} group={group} total={ledger.total} />)}
			<p className="muted">This breakdown is saved outside model context.</p>
		</div>}
	</details>;
}
