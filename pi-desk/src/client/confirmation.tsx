import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "./surfaces.tsx";

interface Options { title: string; context: string; body: ReactNode; accept: string; cancel?: string;
	/** A second way to go ahead, shown beside accept. */
	alternative?: string }
type Choice = "accept" | "alternative" | false;
interface Decision extends Options { scope: string; resolve: (choice: Choice) => void }

export function useConfirmation(scope: string) {
	const [decision, setDecision] = useState<Decision>();
	const pending = useRef<Decision | undefined>(undefined);
	const currentScope = useRef(scope); currentScope.current = scope;
	useLayoutEffect(() => {
		setDecision(undefined);
		return () => { pending.current?.resolve(false); pending.current = undefined; };
	}, [scope]);
	const finish = (item: Decision, choice: Choice) => {
		if (pending.current !== item) return;
		pending.current = undefined; setDecision(undefined);
		item.resolve(item.scope === currentScope.current ? choice : false);
	};
	/** Which way the user went ahead, or false if cancelled. */
	const choose = (options: Options): Promise<Choice> => {
		if (scope !== currentScope.current) return Promise.resolve(false);
		pending.current?.resolve(false);
		return new Promise(resolve => {
			const item = { ...options, scope, resolve };
			pending.current = item; setDecision(item);
		});
	};
	const request = async (options: Options): Promise<boolean> => await choose(options) === "accept";
	const dialog = decision?.scope === scope && <Modal title={decision.title} close={() => finish(decision, false)}>
		<p className="confirmation-context">{decision.context}</p>
		<div className="confirmation-body">{decision.body}</div>
		<div className="dialog-actions">
			<button type="button" data-autofocus onClick={() => finish(decision, false)}>{decision.cancel ?? "Cancel"}</button>
			{decision.alternative && <button type="button" onClick={() => finish(decision, "alternative")}>{decision.alternative}</button>}
			<button type="button" onClick={() => finish(decision, "accept")}>{decision.accept}</button>
		</div>
	</Modal>;
	return { request, choose, dialog };
}
