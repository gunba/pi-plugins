import { createContext, useContext } from "react";
import type { ReferenceOrigin } from "../shared/references.ts";

export const ReferenceContext = createContext<ReferenceOrigin | undefined>(undefined);
export function useReferenceQuery(): string {
	const origin = useContext(ReferenceContext);
	if (!origin) throw new Error("Output must belong to a transcript message.");
	const params = new URLSearchParams({ message: origin.message });
	if (origin.source !== undefined) params.set("source", origin.source);
	return params.toString();
}
