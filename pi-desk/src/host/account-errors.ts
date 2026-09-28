export class AccountSignInRequired extends Error {
	constructor(message = "Sign in to your Pi Desk account on this computer.") { super(message); }
}
