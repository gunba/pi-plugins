import { ModelRuntime, readStoredCredential, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";

export class DotAuthError extends Error {}
export interface DotIdentity {
	accountId: string;
	userId: string;
	accountUserId: string;
	email?: string;
}
export interface DotAuthorization { token: string; identity: DotIdentity }
export type DotAuthorize = (signal?: AbortSignal) => Promise<DotAuthorization>;
type RuntimeFactory = (options: CreateModelRuntimeOptions) => Promise<Pick<ModelRuntime, "getAuth">>;
const field = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;

/** A separately selected saved login; model defaults and models.json do not participate. */
export class DotAuth {
	private runtime?: ReturnType<RuntimeFactory>;
	private identity?: Pick<DotIdentity, "accountId" | "userId">;
	private authPath: string;
	private factory: RuntimeFactory;
	constructor(authPath: string, expected?: Pick<DotIdentity, "accountId" | "userId">,
		factory: RuntimeFactory = options => ModelRuntime.create(options)) {
		this.authPath = authPath; this.factory = factory;
		this.identity = expected && { ...expected };
	}
	readonly authorize: DotAuthorize = async signal => {
		signal?.throwIfAborted();
		if (readStoredCredential("openai-codex", this.authPath)?.type !== "oauth")
			throw new DotAuthError("Choose a saved ChatGPT sign-in for Dot.");
		this.runtime ??= this.factory({ authPath: this.authPath, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
		let token: string | undefined;
		try { token = (await (await this.runtime).getAuth("openai-codex", { signal }))?.auth.apiKey; }
		catch {
			signal?.throwIfAborted();
			throw Error("Dot could not access its saved sign-in. Check the connection or sign-in in Settings.");
		}
		signal?.throwIfAborted();
		let claims: Record<string, any>;
		try {
			if (!token || token.length > 32_000) throw Error();
			claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
			if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw Error();
		} catch { throw new DotAuthError("Dot's saved sign-in did not provide a ChatGPT credential."); }
		const auth = claims["https://api.openai.com/auth"];
		const accountId = field(auth?.chatgpt_account_id ?? auth?.account_id), userId = field(auth?.user_id ?? auth?.chatgpt_user_id);
		if (!accountId || !userId || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now())
			throw new DotAuthError("Dot's saved sign-in is incomplete or expired. Sign into that account again in Settings.");
		if (this.identity && (this.identity.accountId !== accountId || this.identity.userId !== userId))
			throw new DotAuthError("The saved Dot account changed. Reconnect Dot to choose its account.");
		this.identity ??= { accountId, userId };
		return { token: token!, identity: { accountId, userId,
			accountUserId: field(auth?.chatgpt_account_user_id ?? auth?.account_user_id) ?? userId,
			email: field(claims["https://api.openai.com/profile"]?.email) } };
	};
}
