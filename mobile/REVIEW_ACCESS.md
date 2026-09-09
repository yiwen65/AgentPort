# Isolated TestFlight review access

`review_gateway.py` is a small macOS/Linux pairing portal for a dedicated
`agentportreview` account. It is not a general Relay admin API or an OS sandbox.
The active review environment has migrated to Linux; see
`scripts/review-linux/README.md` for the isolated container and restart procedure.
The authoritative deployment/acceptance status is in
`docs/tasks/2026-09-09-testflight-review-access-task.md`.

## Isolation and topology

- Use a separate standard macOS account, private HOME and data, a separate
  credential store, and a verified desktop application copy. Test private-file
  access as that account; checking group names alone is insufficient.
- A reviewer with terminal access can execute commands as the demo account.
  That account can inspect its own files, processes and credentials. Portal
  limits do not constrain an already authorized terminal user. Do not put
  personal files, provider API keys or production Relay tokens in that account.
- Run a **separate** demo Relay with a newly generated registration token; do
  not copy the original Relay's service-wide token. Bind the Relay and portal
  to loopback. Only publish the protected HTTPS page and demo WSS path.
- The connector uses `ws://127.0.0.1:<relay-port>/v1/relay`. Its matching public
  address is `wss://<review-origin>/v1/relay`. The portal maps just the invitation's
  Relay URL to that known public address. It preserves host ID, public key,
  invitation ID, bootstrap secret and expiry. Noise authenticates the host key
  and host/invitation context; the phone still requires WSS.
- Keep the main account's Host, Sessions, Relay and network settings unchanged.

## Private configuration

Run these commands **as the isolated review account**, not the main account or
root. Code may be copied to a tools directory; the deployed copy must match the
verified version. The gateway rejects a different runtime account name.

```sh
python3 review_gateway.py --config "$HOME/Library/Application Support/AgentPortReview/gateway.json"
python3 review_access_control.py --config "$HOME/Library/Application Support/AgentPortReview/gateway.json" status
```

The JSON configuration contains:

| Field | Meaning |
| --- | --- |
| `origin` | Fixed HTTPS origin, no trailing slash, credentials or query |
| `relay_url` | WSS URL at the same origin, path `/v1/relay` |
| `connector_relay_url` | Optional exact literal-loopback internal Relay URL |
| `username` | Dedicated website review username |
| `password_sha256` | SHA-256 of a cryptographically random, high-entropy website password; not a human-chosen password |
| `expires_at` | Website access deadline, Unix seconds |
| `max_devices` | Maximum authorized devices before the portal refuses new codes |
| `max_invitations` | Durable maximum issuance attempts, including uncertain/failed mutations |
| `state_path` | Private issuance counter file; credentials/invitations are not stored here |
| `socket_directory` | Exact dedicated connector's same-UID private IPC directory |
| `port` | Loopback HTTP port |

Configuration, counters, token and credential files must be private (`0600`,
parent `0700`), outside source control. Create a fresh random website password;
never put it in a URL, shell history, command-line upload argument, screenshot or
request log. Supply it to the account owner through a local private file for
acceptance, then enter only the dedicated **website** credentials in App Store
Connect when explicitly authorized. Never supply the macOS account password.

## Portal security contract

- HTTP Basic authentication is carried only through the public HTTPS endpoint.
  Forty failed logins per minute temporarily throttle the portal; this is a
  bounded global protection, not DDoS resistance.
- Reading the page never issues an invitation. A form POST requires the exact
  Host/Origin and an unguessable CSRF token obtained from the authenticated page.
- Use `Referrer-Policy: same-origin`. `no-referrer` caused a real browser's form
  POST to send `Origin: null`, conflicting with strict Origin validation. Keep
  rejecting null/cross-origin requests; do not bypass the check to fix the form.
- Responses use no-store, frame blocking, a restrictive CSP, no external assets
  or scripts. Bodies and authentication headers are not logged.
- The gateway can request only status and automatic invitations. Revocation and
  configuration are **local operator operations**, not public HTTP routes.
- Repeated requests reuse a still-waiting invitation. A lost response cannot
  trigger blind mutation replay: wait for the unknown invitation to expire.
- Each IPC call verifies the private socket and its actual same-UID peer
  (`getpeereid` on macOS, `SO_PEERCRED` on Linux), uses
  bounded frames and a timeout. HTTP worker count, body size and idle time are
  bounded. Do not expose Python's listener directly on all interfaces.

## Reviewer workflow

1. Open the review HTTPS page using the dedicated website credentials.
2. Press **Get connection code**, copy the entire code, and use it within two
   minutes. The QR/code is a bearer credential; do not share it elsewhere.
3. In AgentPorts device management, choose **Scan to pair → No camera? Paste
   pairing code**. Paste, validate, name the device and connect.
4. Open **Review Demo → Review Terminal**. Example commands: `pwd`, `ls`, and
   `cat README.txt`. Test typing, scrolling, paste and reconnect.
5. A paired phone can reconnect without another short-lived code until revoked.

This demo contains a real Shell terminal, not pre-recorded responses. No paid
agent-provider credentials are included. Do not claim this demonstrates every
provider-specific feature or guarantees Apple review approval.

## Shutdown and revocation

Website expiry **does not revoke paired devices**. At review completion:

1. Remove the task-owned HTTPS and WSS public routes (verify no unrelated routes
   have been added before using a whole-port `tailscale funnel ... off`).
2. Stop the task-owned gateway, checking its process identity rather than blindly
   trusting an old PID file. Do not kill any `agentport-host` or the private GUI.
3. As the review account, run:

   ```sh
   python3 review_access_control.py --config "$HOME/Library/Application Support/AgentPortReview/gateway.json" revoke-all
   ```

   It closes outstanding enrollment before taking a fresh device snapshot,
   revokes all demo devices and checks durable authorization removal. A timeout
   is uncertain, not success: inspect status before proceeding.
4. Verify an old phone identity can no longer reconnect and external HTTP/WSS
   access is closed. Removing only the webpage is not sufficient.

Mac availability, sleep/lid behavior, login keychain availability and service
restart behavior need deployment-specific verification. A set of running
background processes does not establish reboot recovery. Keep the Mac powered
and available; after any reboot, verify the full path before relying on it.

## Checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 mobile/scripts/test-review-gateway.py
```

Tests include real same-user Unix socket framing, authentication, CSRF, origin,
body limits, budget persistence, offline/unknown-mutation refusal, URL mapping
without changing identity, configuration restrictions, and enrollment/revocation
races. They do not replace a physical phone on a separate network, OS isolation
checks, UI accessibility review or actual revocation/reconnect testing.
