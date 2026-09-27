import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

void broadcastResponseToMainFrame().catch(() => {
	document.body.textContent = "Sign-in did not complete. Return to Pi Desk and try again.";
});
