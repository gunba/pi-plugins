export class AccountSignInRequired extends Error {
	readonly freshAuthentication: boolean;
	constructor(message = "Sign in to your Pi Desk account on this computer.", freshAuthentication = false) {
		super(message); this.freshAuthentication = freshAuthentication;
	}
}
