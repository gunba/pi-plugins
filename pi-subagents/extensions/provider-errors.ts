export type ProviderStatus = {
	stopReason?: string;
	errorMessage?: string;
};

function rejectedImageContent(raw: string): boolean {
	if (!raw.includes("image_url")) return false;
	return ["mime", "base64", "data url", "image mime"].some((term) =>
		raw.includes(term),
	);
}

function rejectedRequestShape(raw: string): boolean {
	const invalidRequest = ["invalid request", "invalid 'input[", "invalid input"].some(
		(term) => raw.includes(term),
	);
	const schemaMismatch = ["expected", "unsupported", "schema"].some((term) =>
		raw.includes(term),
	);
	return invalidRequest && schemaMismatch;
}

export function providerFailureHint(status: ProviderStatus): string | undefined {
	const raw = `${status.stopReason ?? ""} ${status.errorMessage ?? ""}`.toLowerCase();
	if (!raw.trim()) return undefined;

	if (rejectedImageContent(raw)) {
		return "Provider rejected serialized image content. Reload the fixed pi-codex-compat extension; retrying unchanged history will repeat the error. Use /repair-session-images for a backed-up permanent repair.";
	}

	if (rejectedRequestShape(raw)) {
		return "Provider rejected the serialized request shape. Retrying unchanged history is unlikely to recover; inspect and repair the saved session content first.";
	}

	return undefined;
}
