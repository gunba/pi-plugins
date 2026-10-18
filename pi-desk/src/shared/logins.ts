export type ProviderAuthType = "oauth" | "api_key";
/** A provider Pi can sign into, and its login on this computer if there is one. */
export interface LoginProvider {
	id: string; name: string; types: ProviderAuthType[]; subscription?: boolean;
	signedIn?: { type: ProviderAuthType; identity?: string };
}
export interface SignIn {
	id: string; provider: string; type: ProviderAuthType; created: string;
	state: "starting" | "waiting" | "completed" | "failed" | "cancelled";
	message?: string; error?: string;
	links?: { label: string; url: string }[];
	device?: { code: string; expires?: number };
	prompt?: { id: string; kind: "select" | "text" | "manual_code" | "secret"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] };
}
export interface LoginsSnapshot { providers: LoginProvider[]; signIns: SignIn[] }
