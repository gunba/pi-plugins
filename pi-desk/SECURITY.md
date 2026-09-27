# Security

Pi Desk grants access to a Pi account, not just its conversations. An authorized
browser can run tools with the computer user's permissions: read files and
credentials, change code and launch processes. It is not a sandbox. Run the
connector as an ordinary user.

This implementation has not had an independent security audit. It supports one
trusted owner, not mutually untrusted users or project-level access roles.

## Trust boundaries

There are three separate services:

- **Static app:** delivers the browser code. Its publisher is trusted.
- **Account authority:** validates Microsoft sign-in, owns the device directory,
  issues short-lived device credentials and answers membership checks. It is
  trusted to authorize access to the computers.
- **Routing broker:** connects browsers to computers and forwards ciphertext.
  It does not receive Microsoft tokens, account signing keys, Pi credentials
  or native conversations.

Compromising only the broker must not grant PC access. Compromising the account
authority can authorize an attacker. Compromising the app publisher can deliver
JavaScript that uses the signed-in browser's authority to issue commands.
Encryption and Content Security Policy do not protect against malicious
deployment of the app's own code.

Separate services must also have separate runtime secrets and publishing
permissions. Sharing a hosting plan does not isolate them from a compromised
hosting administrator or underlying platform.

## Authentication and access

The browser and each computer use Microsoft's authorization-code/PKCE flow
through MSAL. The account service accepts only delegated **access tokens** for
its configured application and `Workspace.Access` scope. It validates signature,
tenant issuer, audience, authorized client, expiry and the immutable owner
object ID. An ID token, Microsoft Graph token or matching email address is not
authorization.

Each enrolment creates a P-256 signing key. Account requests that change device
state prove possession of that key, binding the method, URL, body, access token,
timestamp and replay identifier. The authority issues ES256 device credentials
lasting at most ten minutes, bound to the owner, device ID, role and public key.
A public device credential alone is not a bearer key for opening a channel.

Every signed-in browser discovers the same account directory. Access covers
each enrolled computer's Pi host, not a single conversation or a read-only role.
Renames and removals apply account-wide. There are no remote invitation secrets
or per-browser/per-computer grants.

Both endpoints independently check membership and key identity with the
authority. Membership leases last at most 60 seconds, bounded from the start
of the request using a monotonic clock. Renewal runs every 20 seconds. An
outage is not permission to extend a lease: expired or revoked peers lose new
command and event access. Already admitted work and bytes already sent cannot
be recalled. Revocation does not stop that work or reverse its effects.

Removing an enrolment is **not** revoking the owner's Microsoft credentials.
Maintained clients require explicit sign-in to enrol again after removal.
Someone who still has valid owner tokens or can sign in as the owner can enrol
a new identity. Address Microsoft account compromise at Microsoft as well.

## Encrypted connections

Computers connect outbound; no inbound PC port, router forwarding or VPN is
needed. Host admission at the broker requires a fresh challenge signed by the
enrolled key. Browser and computer then independently verify each other's
authority-issued credential and possession proof.

Each channel uses fresh ephemeral ECDH P-256 keys. Signed proofs bind the
intended computer, both roles, API/protocol revisions, nonces and ephemeral
keys. HKDF binds the handshake transcript and derives separate AES-256-GCM
direction keys. Ordered counters reject reused frames; message sizes,
incomplete transfers and queues are bounded. Credential renewal cannot change
the peer's identity or key. HTTPS/WSS protects the outer connection.

This replaces durable shared message secrets with ephemeral channel keys. It
is not a claim of audited forward secrecy or guaranteed erasure of JavaScript
runtime memory. A compromised endpoint can access its live keys and content.

The broker can observe connection metadata, withhold traffic, disconnect peers
and record ciphertext. It must not also serve the app or hold its publishing
credentials, the authority's signing key, or access to its private directory.

## Storage and local recovery

Native signing keys and Microsoft caches use MSAL's platform-protected
persistence: current-user DPAPI on Windows and Secret Service on Linux. Linux
requires an available, unlocked Secret Service; there is no plaintext fallback.
Do not copy these stores to another computer or assume Unix file modes create
Windows ACLs. Keep the data directory in the user's private profile.

The browser stores a non-extractable signing key in IndexedDB and uses MSAL's
supported cache. Non-extractable does not prevent malicious same-origin code
from using the key. The browser profile, privileged browser extensions, OS
account and Microsoft account remain trusted. Use OS screen locks and MFA.
Desk has no separate app-unlock or per-command reauthentication.

Sign-out revokes that browser's enrolment before clearing its local identity
and MSAL cache. It is not a global Microsoft logout. Unsent text and attachments
remain on that browser until removed or site data is cleared; they are not
synced through the directory.

Messages explicitly sent to a starting worker are saved on that computer in
`inputs.sqlite`, not on the authority or broker. Unresolved text and attachment
references remain available to authorized browsers until resolved or discarded.
This store, uploaded files and native Pi history rely on the user's private
profile and filesystem protection; they are not encrypted credential stores.
Host admission can outlive a browser disconnect or revocation. A host restart
retains unresolved input for review but never automatically resends it.

The loopback endpoint remains for local process management and trusted
recovery. `pi-desk open --local` creates a short-lived recovery link; normal
access uses the shared website. Local recovery and process-management
credentials cannot be minted through remote API requests. Host/Origin and
application-version checks apply before ordinary API handling.

Local recovery grants are separate from account enrolments. Revoking one does
not revoke the other. A copied local recovery link grants substantial local
access; keep it private.

## Deployment and incidents

- Protect Microsoft, hosting, source and deployment accounts with MFA and
  limited privileges. Disable unused publishing passwords, FTP and debugging.
- Keep deployment metadata and secrets outside the source repository. Public
  bootstrap/configuration and JWKS endpoints intentionally expose origins,
  account/application identifiers and public keys; these are not passwords.
- Persist and back up the authority's directory and signing key privately.
  Do not roll back to a directory backup that restores revoked enrolments.
  Key rotation requires a coordinated cache/connection rollover; a redeploy
  should normally preserve the existing key.
- Run one authority writer and one broker instance; neither implements
  replicated state. Keep the static app separate from both.
- Keep TLS/hostname verification enabled. Use approved proxy and CA settings,
  not network-policy bypasses. Obtain approval before connecting a work PC.

For a lost browser, use a trusted signed-in browser's **Browser access** controls
to remove it. For a lost computer, remove it from **Computers**. Review activity
and exposed credentials if its access may have been used.

If the authority or app publisher may be compromised, do not trust the website
for recovery. `pi-desk stop` from trusted local code stops that computer's host
and workers. Stopping only the broker interrupts remote connections but leaves
native work running. Restore trusted deployments and review Microsoft sessions,
enrolments, browser service workers/site storage and PC credentials before
reconnecting. Revoking one key alone does not prove an attacker has been removed.

The interface escapes model/tool text and displays HTML/SVG files as text rather
than executing them. Those controls mitigate browser injection; they do not
make model instructions or Pi tools safe to run without judgment.
