import type { ServiceUsageSnapshot } from "../../../pi-service-usage/index.ts";
import type { ModelCallsView } from "../../../pi-model-calls/settings.ts";
export type { ModelCallsView };

export interface ServicesSnapshot {
	exa: { configured: boolean; environment: boolean };
	/** ask_model's model and limit; absent from hosts older than ask_model. */
	models?: ModelCallsView;
	usage: ServiceUsageSnapshot;
}
/** A provider whose API keys ask_model can use. */
export interface ModelProvider { provider: string; name: string }
/** One of its chat models. Prices are USD per million tokens. */
export interface ModelOption { id: string; name: string; efforts: string[]; input: number; output: number }
