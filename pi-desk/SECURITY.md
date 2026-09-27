# Security

Pi Desk is remote access to a Pi account, not just a conversation viewer.
A paired browser can start sessions and run the account's tools. Those tools
can read credentials and files, change code, and launch processes with the same
OS permissions as Pi. Do not run the connector as an administrator.

This is a new implementation, not an independently audited remote-access
product. It is intended for computers and devices controlled by one trusted
owner, not mutually untrusted users.

## Access

- The PC listens on loopback and connects outbound to the relay. No inbound PC
  port or router forwarding is needed.
- The relay registration secret admits PC connectors. It does not, by itself,
  grant access to a PC's sessions or tools.
- A remote invitation contains a random 256-bit secret and expires after ten
  minutes. Successful pairing replaces it with a separate browser-generated
  persistent key. The old invitation cannot authenticate another browser.
- Each browser is authorized separately on each PC. That authorization covers
  the whole Pi host, not a single project or a read-only role.
- Paired devices can create invitations and revoke other devices. Treat their
  authority like a remote shell key. Pair only devices and browser profiles you
  trust, and share invitations privately.
- Revocation closes that device's connections and prevents new requests. It
  does not undo commands already admitted, stop every process they might have
  launched, or reverse other changes made with that access.

Local access also requires authentication. Process-management credentials are
separate, short-lived and unavailable through relay routing. Host/Origin
validation and application API checks apply before normal request handling.

## Encryption and its limits

Remote application messages use Web Crypto AES-256-GCM. HKDF derives separate
direction keys from the device secret and fresh nonces from both endpoints.
Ordered counters reject reused frames; incomplete messages and queues are
bounded. HTTPS/WSS protects the outer connection.

The relay can observe connection metadata, disrupt service and record encrypted
frames. Without device keys, it cannot decrypt or forge those frames.

**The separately hosted browser application remains trusted.** The broker does
not serve the app, and its process must not hold the static site's publishing
credentials or have write access to its files. Compromising only the broker
therefore does not also allow replacing the app.

If an attacker can change the app through its hosting, source or deployment
account, its JavaScript can use or steal paired-device keys and issue commands.
Encryption between the browser and PC does not remove this trust boundary.
Content Security Policy does not protect against a malicious deployment of
the application's own code.

Browser keys are stored in that origin's local storage. The browser profile,
extensions with access to it, OS account and app-deployment account are therefore
trusted. Protect devices with their OS screen lock and keep browsers updated.
Desk currently has no separate app-unlock or per-command reauthentication.

The channel uses a persistent symmetric device key, not ephemeral Diffie–Hellman.
It does **not** provide forward secrecy against later theft of that key: someone
with recorded encrypted frames and the key could decrypt those past frames.
Separate static delivery reduces relay-process compromise risk. Clients are
not independently verified or signed native applications.

## Deployment

- Protect hosting, source and deployment accounts with MFA and limited access.
  Disable unused publishing passwords, FTP and remote debugging.
- Deploy the matching static client and standalone relay to separate services.
  Never give the broker the static site's publishing credentials. Do not put Pi
  credentials, native sessions or PC device keys on the server.
- Keep the registration secret in private environment/settings storage, not
  command arguments, package archives, browser code or URLs.
- Keep PC data in a private user directory. Unix file modes do not establish
  Windows ACLs; do not use a shared/public Windows directory for access or
  login-start records.
- Leave TLS certificate and hostname verification enabled. Use an approved
  proxy/CA configuration rather than bypassing workplace controls.
- Use one relay process/instance. Its routing state is not shared between
  replicas. A relay outage disconnects browsers without stopping PC workers.

The interface escapes model/tool text, restricts image types, and displays
HTML/SVG files as text rather than executing them. These controls address
browser injection; they do not make model instructions or tool use a sandbox.

## Lost device or suspected compromise

Use a trusted local installation and browser:

```sh
pi-desk open --local --pair
```

Revoke the affected device in Settings → Device access. Do not trust the public
app for recovery if its hosting or deployed JavaScript may be compromised.
Stopping the relay disconnects remote clients while PC workers continue.
`pi-desk stop` stops the local host and its workers as well.

If access may already have been used, review PC activity and exposed credentials;
revoking one key alone is not proof that access has been removed. A compromised
web deployment also requires reviewing its service worker/browser storage and
re-pairing from trusted code.

Automated checks and dependency scans are useful evidence, not a security
certification. Obtain the organization's approval before connecting a work PC.
