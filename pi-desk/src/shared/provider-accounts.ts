export type ProviderAuthType = "oauth" | "api_key";
export interface AccountProvider { id: string; name: string; types: ProviderAuthType[]; subscription?: boolean }
export interface ProviderAccount {
	id: string; provider: string; name: string; identity?: string; native?: boolean;
}
export interface ProviderSignIn {
	id: string; provider: string; name: string; created: string; type?: ProviderAuthType;
	state: "starting" | "waiting" | "saving" | "completed" | "failed" | "cancelled" | "interrupted";
	message?: string; account?: string; error?: string;
	links?: { label: string; url: string }[];
	device?: { code: string; expires?: number };
	prompt?: { id: string; kind: "select" | "text" | "manual_code" | "secret"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] };
}
export interface ProviderAccountsSnapshot { defaults: Readonly<Record<string, string>>; providers: AccountProvider[]; accounts: ProviderAccount[]; signIns: ProviderSignIn[] }
