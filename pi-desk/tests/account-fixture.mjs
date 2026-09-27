import { generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { DeviceAuthority } from "../src/account/identity.ts";
import { deviceKey } from "../src/shared/account.ts";
import { CredentialVerifier } from "../src/shared/device-credential.ts";
import { signChannelProof } from "../src/shared/account-channel.ts";

export async function accountFixture(overrides = {}) {
	const config = { origin: "https://account.example", relayOrigin: "http://127.0.0.1:1",
		appOrigins: ["https://app.example"], tenantId: crypto.randomUUID(), clientId: crypto.randomUUID(),
		ownerObjectId: crypto.randomUUID(), ...overrides };
	const signing = await generateKeyPair("ES256", { extractable: true });
	const authority = await DeviceAuthority.open(config, await exportJWK(signing.privateKey));
	const verifier = new CredentialVerifier(config, createLocalJWKSet({ keys: [authority.publicKey] }));
	const owner = { tenantId: config.tenantId, objectId: config.ownerObjectId, expires: Math.floor(Date.now() / 1000) + 3600 };
	const device = async kind => {
		const keys = await generateKeyPair("ES256", { extractable: true });
		const data = { id: crypto.randomUUID(), kind, name: "Fixture", created: Date.now(), seen: Date.now(), connected: false,
			...await deviceKey(await exportJWK(keys.publicKey)) };
		const certificate = (await authority.credential(data, owner)).token;
		return { device: data, certificate: async () => certificate,
			signProof: (payload, purpose) => signChannelProof(payload, purpose, keys.privateKey) };
	};
	return { config, verifier, device };
}
