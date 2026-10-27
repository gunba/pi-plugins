import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ServiceUsage } from "./index.ts";

/** Observe native classifier/image usage without changing credentials or results. After stopping callers, await the returned drain before closing the ledger. */
export function trackServiceModels(runtime: ModelRuntime, usage: ServiceUsage, warn: (message: string) => void): () => Promise<void> {
	const pending = new Set<Promise<unknown>>();
	const track = <T extends { stopReason?: string; usage?: { cost: { total: number } } }>(service: string, operation: string, run: () => Promise<T>): Promise<T> => {
		const job = (async () => {
			let cost: number | undefined;
			try {
				const result = await run(), reported = result.usage?.cost.total;
				// Native error results can carry a zero-usage placeholder even when billing is unknown.
				cost = result.stopReason && result.stopReason !== "stop" && reported === 0 ? undefined : reported;
				return result;
			}
			finally {
				try { usage.record({ service, operation, cost, estimated: true }); }
				catch { warn("A model service request finished, but its cost could not be recorded on this computer."); }
			}
		})();
		pending.add(job); void job.then(() => pending.delete(job), () => pending.delete(job));
		return job;
	};
	const classify = runtime.classify.bind(runtime), images = runtime.generateImages.bind(runtime);
	runtime.classify = (model, context, options) => track(model.provider, "classify", () => classify(model, context, options));
	runtime.generateImages = (model, context, options) => track(model.provider, "images", () => images(model, context, options));
	return async () => { await Promise.allSettled([...pending]); };
}
