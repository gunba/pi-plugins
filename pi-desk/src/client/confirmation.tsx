import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "./surfaces.tsx";

interface Options { title: string; context: string; body: ReactNode; accept: string; cancel?: string }
interface Decision extends Options { scope: string; resolve: (accepted: boolean) => void }

export function useConfirmation(scope: string) {
	const [decision, setDecision] = useState<Decision>();
	const pending = useRef<Decision | undefined>(undefined);
	const currentScope = useRef(scope); currentScope.current = scope;
	useLayoutEffect(() => {
		setDecision(undefined);
		return () => { pending.current?.resolve(false); pending.current = undefined; };
	}, [scope]);
	const finish = (item: Decision, accepted: boolean) => {
		if (pending.current !== item) return;
		pending.current = undefined; setDecision(undefined);
		item.resolve(accepted && item.scope === currentScope.current);
	};
	const request = (options: Options): Promise<boolean> => {
		if (scope !== currentScope.current) return Promise.resolve(false);
		pending.current?.resolve(false);
		return new Promise(resolve => {
			const item = { ...options, scope, resolve };
			pending.current = item; setDecision(item);
		});
	};
	const dialog = decision?.scope === scope && <Modal title={decision.title} close={() => finish(decision, false)}>
		<p className="confirmation-context">{decision.context}</p>
		<div className="confirmation-body">{decision.body}</div>
		<div className="dialog-actions">
			<button type="button" data-autofocus onClick={() => finish(decision, false)}>{decision.cancel ?? "Cancel"}</button>
			<button type="button" onClick={() => finish(decision, true)}>{decision.accept}</button>
		</div>
	</Modal>;
	return { request, dialog };
}
