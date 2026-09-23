export const MOBILE_ASK_REQUEST = "pi-mobile-bridge/ask-request";
export const MOBILE_ASK_CLOSE = "pi-mobile-bridge/ask-close";

export type MobileAnswer =
	| { kind: "selection"; selections: string[]; comment?: string }
	| { kind: "freeform"; text: string }
	| null;

export interface MobileAskRequest {
	id: string;
	question: string;
	context?: string;
	options: Array<{ title: string; description?: string }>;
	allowMultiple: boolean;
	allowFreeform: boolean;
	allowComment: boolean;
	accepted?: boolean;
	answer: (response: MobileAnswer | undefined) => void;
}
