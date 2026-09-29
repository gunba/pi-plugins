/** Display-only labels, never authentication decisions or raw credential fields. */
export function providerIdentity(credential: unknown): string | undefined {
	if (!credential || typeof credential !== "object" || !("type" in credential) || credential.type !== "oauth") return;
	const value = credential as Record<string, unknown>;
	const label = (item: unknown): string | undefined => typeof item === "string" && item.length <= 200 && !/[\x00-\x1f]/.test(item) ? item : undefined;
	const claims = (token: unknown): Record<string, any> => {
		if (typeof token !== "string" || token.length > 32_000) return {};
		try { const data = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
			return data && typeof data === "object" && !Array.isArray(data) ? data : {}; } catch { return {}; }
	};
	const access = claims(value.access), id = claims(value.idToken ?? value.id_token);
	const email = label(value.email) ?? label(id.email) ?? label(access.email) ?? label(access["https://api.openai.com/profile"]?.email);
	const auth = access["https://api.openai.com/auth"] ?? id["https://api.openai.com/auth"];
	const account = label(value.accountId) ?? label(auth?.chatgpt_account_id);
	const plan = label(auth?.chatgpt_plan_type);
	return [email, plan, account ? `Account ${account}` : undefined].filter(Boolean).join(" · ") || undefined;
}
