import type { ExtensionAPI, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

export const MODEL_CREDENTIALS_DISCOVER = "pi:model-credentials";
export const MODEL_ACCOUNT_CHANGED = "pi:model-account-changed";
export interface ScopedModelRuntime {
	runtime: ModelRuntime;
	binding: ModelCredentials;
	ownsProvider(provider: string): boolean;
}
/** A scoped factory preserves credential routing without exposing tokens to the driver. */
export interface ModelCredentials {
	accountId?(provider: string): string;
	onChange?(listener: () => void): () => void;
	create(manager: SessionManager, signal: AbortSignal): Promise<ScopedModelRuntime>;
}
export function getModelCredentials(pi: Pick<ExtensionAPI, "events">): ModelCredentials | undefined {
	const request: { binding?: ModelCredentials } = {};
	pi.events.emit(MODEL_CREDENTIALS_DISCOVER, request);
	return request.binding;
}
export function installModelCredentials(pi: ExtensionAPI, binding: ModelCredentials): void {
	const release = pi.events.on(MODEL_CREDENTIALS_DISCOVER, raw => {
		if (raw && typeof raw === "object") (raw as { binding?: ModelCredentials }).binding = binding;
	});
	const stop = binding.onChange?.(() => pi.events.emit(MODEL_ACCOUNT_CHANGED, {}));
	pi.on("session_shutdown", () => { release(); stop?.(); });
}
