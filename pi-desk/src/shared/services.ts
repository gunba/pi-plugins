import type { ServiceUsageSnapshot } from "../../../pi-service-usage/index.ts";

export interface ServicesSnapshot {
	exa: { configured: boolean; environment: boolean };
	usage: ServiceUsageSnapshot;
}
