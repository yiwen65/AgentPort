# AgentPort Relay (v1)

Self-hosted, bounded WebSocket routing for native AgentPort endpoints. Both
computer and phone make outbound connections; the phone does not need a route
to the computer, and SSH is not part of this transport.

**Integration status:** the desktop Phone Pairing and Mobile Scan to pair flows
use this Relay for both authorization and terminal traffic. Manual SSH profiles
remain independent and unchanged. Native adapters keep long-lived keys in their
platform credential stores; Relay carries routing metadata/ciphertext only.

**Scan-to-connect (2026-09-07):** creating a QR in desktop settings now explicitly
authorizes its first authenticated holder, without a second approval click or
comparison-code step. The QR is a short-lived (120-second), one-time **bearer
access credential**: anyone who obtains it before consumption/expiry can enroll
a phone. Keep it private; scan only a trusted computer's QR. Native authorization
is persisted before success, and Mobile connects only after validating that
approval. Registration tokens are never included. Revocation is unchanged.
The legacy `Invite`/`Decide` IPC remains for explicit-approval clients; the new UI
uses `InviteAutomatic` and requires an updated running connector.
Progress and runtime verification boundaries are tracked in
[`mobile-session-reliability-pairing-task.md`](../../docs/tasks/2026-09-05-mobile-session-reliability-pairing-task.md).
The historical SSH QR native commands are removed; legacy SSH authorizations are
not automatically revoked or migrated. The standalone `agentport-pairing` crate
remains historical workspace test code, not a native pairing dependency.

## Build and isolated local use

```sh
cargo build -p agentport-relay --features server --bin agentport-relay
# Create a NEW deployment credential, never overwrite an existing token.
umask 077
TOKEN_DIR=$(mktemp -d)
openssl rand -hex 32 > "$TOKEN_DIR/host-token"
target/debug/agentport-relay --bind 127.0.0.1:8787 \
  --host-token-file "$TOKEN_DIR/host-token"
```

Native clients can use `ws://127.0.0.1:8787/v1/relay` for isolated loopback
verification. An actual phone cannot reach a computer's loopback address.
`ws://` is rejected outside literal loopback IPs; use WSS for real networks.
No SSH, firewall, router, login item or system service is installed by this CLI.
Ctrl-C stops this Relay instance and its channels, not any Session Host.

The token file is limited to 1024 bytes, with a trimmed token of 16–256 bytes
(use at least 32 random bytes). On Unix the opened file must be regular, owned
by the process user, single-link, and inaccessible to group/others; symlinks
are rejected. The token is not accepted on the command line or printed. Keep
its parent directories private and trusted. Non-Unix deployments must enforce
file access using OS ACLs; the CLI's Unix ownership/mode checks are not portable.

## Self-deployment and TLS

Deployment is an operator action, **not performed by the local test/build**.
Use a dedicated unprivileged account and run the WS listener on loopback behind
a TLS reverse proxy. Provision a domain/certificate trusted by WebPKI; clients
do not offer an insecure certificate override. Example Caddy configuration:

```caddyfile
relay.example.com {
    @agentport path /v1/relay
    reverse_proxy @agentport 127.0.0.1:8787
    respond 404
}
```

Configure the endpoint as `wss://relay.example.com/v1/relay`. Preserve WebSocket
upgrades and long-lived connections; do not buffer or log request/response
bodies. Do not expose the plaintext backend or add proxy authentication that
places credentials in URLs. TLS protects the computer's deployment registration
token from network observers; end-to-end Noise separately protects endpoint data
from the Relay and TLS terminator. URL userinfo, query strings, fragments, wrong
paths, and browser `Origin` upgrades are rejected.

Provide the deployment registration token to authorized computers through a
separate secure channel. **Never put it in a QR or Mobile profile.** The server
keeps only its SHA-256 digest during operation. The token permits computer route
registration, not device authorization or terminal decryption. A fresh private-key
possession proof is also required to claim a particular computer route. Restarting
the server with a new token disconnects existing routes; update legitimate
computers separately. There is no public account service or administrative HTTP API.

Capacity defaults: 256 live sockets, 64 registered computers, 8 pending joins per
computer (library limits are validated). Each connected phone uses two sockets
in addition to the computer registration socket. Upgrade/control/read/write
operations have 10-second deadlines; heartbeats run every 15 seconds, with a
50-second idle threshold checked on heartbeat. Ciphertext frames/messages are
limited to 65,535 bytes; JSON control messages to 4,096 bytes. Bounded queues and
stream buffers apply backpressure; stalled peers are disconnected, not buffered
indefinitely. Unauthenticated join attempts can still exhaust capacity: add
operator-managed network/rate limits for a public deployment. These caps are not
a claim of DDoS resistance. Proxy TLS/certificate deployment is not locally tested.

## Cryptographic and authorization boundaries

- Endpoint static identities are X25519. `hostId` is SHA-256 of the computer
  public key. Endpoint adapters must keep private keys in platform credential
  storage, never in QR, logs, public profiles or Relay state.
- Pairing uses `Noise_XXpsk0_25519_ChaChaPoly_BLAKE2s`. A 120-second QR contains a
  random 256-bit bootstrap PSK, invitation ID, pinned computer public key, Relay
  URL and expiry. Protect QR visibility until used. The computer identity is
  checked before the phone sends its static identity/name. Both endpoints show
  the same transcript-derived `XXXX-XXXX` comparison code.
- Session connections use `Noise_IK_25519_ChaChaPoly_BLAKE2s`. The computer learns
  the authenticated phone key from message one. **The endpoint must check its
  durable device allowlist before message two and before starting Bridge.** The
  handshake helper alone does not grant permission.
- Relay registration uses a fresh `Noise_NK_25519_ChaChaPoly_BLAKE2s` challenge
  to prove possession of the computer's static private key. Separate prologues
  bind registration versus a particular Accept connection ID. Possessing another
  computer's public key or a prior proof cannot claim its route.
- Pairing/session prologues bind the computer route and connection mode;
  pairing additionally binds the invitation ID. Noise transport nonces reject
  altered/repeated ciphertext; reconnect always needs a fresh handshake.
- The endpoint connector enforces one authenticated candidate per invitation,
  durable authorization, expiry, and revocation. New desktop QR invitations grant
  authorization on creation to their first authenticated holder; legacy explicit
  approval invitations still require `Decide`.
  Revocation first persists removal, then aborts and joins that device's channel
  tasks before acknowledging; other devices remain connected. It does not issue
  Session stop/archive operations. These guarantees are tested at the connector
  boundary, not supplied by blind routing.
- Stream flush waits for preceding bytes to be sent by the WebSocket pump. It
  does **not** prove the Bridge executed a command. Drop/cancellation closes the
  channel; half-close is not supported. The caller must preserve uncertain-write
  non-replay semantics, including after a disconnect or failed flush.

Relay-visible metadata includes IPs, computer public key/route, invitation ID,
connection mode, timing, ciphertext sizes and deployment credential at
registration. Phone identity and terminal content are inside Noise. The Relay
can deny service, delay, drop, or correlate traffic; encryption does not hide
metadata, protect a compromised endpoint, or validate a malicious QR source.

Dependencies are pinned to `snow 0.10.0` and `tokio-tungstenite 0.29.0`.
Snow's published README states it has **not received a formal security audit**;
neither has this integration. Do not describe this as audited or production
security-certified. Independent protocol/application review is recommended
before exposing sensitive real Sessions through a public deployment.

## Verification

```sh
cargo test -p agentport-relay --features server,connector
cargo clippy -p agentport-relay --all-targets --features server,connector -- -D warnings
cargo fmt -p agentport-relay --check
```

Tests use fresh identities, temporary files and ephemeral loopback listeners;
no existing credentials, SSH configuration, or user Sessions are accessed.
Coverage includes pinning before identity disclosure, tampering/replay/wrong PSK,
registration challenge binding, cross-computer Accept isolation, generation
replacement, queue/socket/frame limits, private token files, and bidirectional
multi-chunk encrypted streams (including flush-before-drop), exact approval,
unknown approval key custody, durable device state, revocation closing all and
only the selected device's channels, Relay restart recovery and bounded local IPC.
Tests inject an in-memory credential vault; platform Keychain access is not
claimed from these tests.

To exercise the actual bundled Bridge with a new isolated data/socket root:

```sh
bash src-tauri/scripts/build-sidecar.sh debug
AGENTPORT_RELAY_TEST_BRIDGE="$PWD/target/debug/agentport-remote-bridge" \
  cargo test -p agentport-relay --features server,connector real_bridge_hello \
  -- --ignored
```

This optional check sends only Bridge hello and `project.list` into an empty
fixture database, then revokes its Relay channel; it never accesses user Sessions.

## Independent desktop connector

`agentport-connector` is a separate process built with the `connector` feature
and bundled beside `agentport-remote-bridge`. It has a fixed Bridge executable
and argument list (`serve --stdio`), not an IPC-configurable shell command. It
passes the selected AgentPort data root and Host socket directory to each Bridge.
Each authenticated phone connection owns only its Bridge attachment process;
closing the channel kills that Bridge, not any independent Session Host.

Desktop native commands:

- `desktop_relay_start`: explicitly start or reuse this installation's connector.
- `desktop_relay_status`: get authoritative phase/peer/device/pairing/channel state.
- `desktop_relay_control`: bounded Configure, Invite, Decide, CloseInvitation,
  Revoke and Stop requests. Configure contains the deployment token; it is never
  echoed. Do not log invoke payloads. Failed/unknown mutations must be followed
  by a status refresh, not automatic replay.

On each desktop app launch, backend setup asynchronously starts or reuses this
installation/data-root connector once, using the same start lock as manual Start.
Startup failures are logged without preventing the GUI from opening; there is no
automatic retry, pairing invitation, or new device authorization. Existing saved
configuration and authorizations remain in effect. Manual Stop keeps it stopped
for the current GUI lifetime unless you explicitly Start again; the next app
launch attempts startup again.

The GUI launches the connector in a separate POSIX session with null stdio;
closing the GUI does not stop it. **No OS boot/login autostart** is installed.
After a machine restart, opening AgentPort starts it again (or start it manually).
GUI app updates do not automatically replace an already-running connector: explicitly
Stop/Start to use the updated sidecar (this disconnects Relay attachments but
preserves Session Hosts).

Persistent state lives in `<AgentPort data>/relay-connectors/<namespace>/`;
private Unix IPC lives in `/tmp/agentport-relay-<uid>-<namespace>/control.sock`.
The namespace hashes the canonical bundle binary directory and data root. This
keeps debug/release/checkouts distinct while preserving identity across GUI
restarts and bundle updates at the same path. Install-path changes intentionally
use another namespace; no credentials are silently migrated. Two installations
can still expose the same underlying Session data if configured to share it;
verify the intended computer name/key before approval.

Directories are owner-only (0700); state/lock/socket files are private. Persistent
state has a lifetime exclusive flock, bounded no-follow regular-file reads and
atomic write+fsync+rename. Another lifetime lock protects stale IPC socket cleanup.
IPC checks socket metadata and kernel peer UID on both sides, with at most 8
clients, 8 KiB requests, 64 KiB responses and read/write deadlines. This is a
**same-OS-user boundary**, not protection from malicious code already running as
that user, root, or a compromised GUI; such principals can approve remote access.

Keychain stores newly generated computer identity and registration token under
random accounts in `com.agentport.relay.connector.v1`. JSON holds only public
identity, opaque account references and allowed device keys/names/timestamps.
Configuration is written/read back in Keychain before its metadata is persisted
or a Relay connection is attempted. Missing/locked credentials fail closed;
existing identities are never regenerated automatically and no plaintext fallback
exists. Reconfiguration preserves computer/device identities, stores a new token
account and closes old Relay channels. Old/new orphan accounts are deliberately
not deleted after unknown configuration outcomes; operators should retain them
until the authoritative config is known. Existing manual SSH credentials and
`authorized_keys` are not read, written, migrated or removed by the connector.

Only an authenticated pairing handshake claims an invitation; the exact
invitation/request/phone key must match desktop approval. Approval is persisted
before encrypted success is sent. A phone whose connection disappears while
approval is in flight must keep its identity/profile for reconciliation. Creating
another invitation cancels the previous pending exchange, not its already-durable
authorization. Removing a device rejects future authenticated sessions and closes
its live channels. A persistence failure reports an error, disables new access
and still closes the targeted revoked channels; it must not be shown as successful
revocation across restart until durable state has been verified.

The connector bounds simultaneous handshake/channel work to 32 and live channels
per device to 8, with at most 64 allowed devices. Its registration retries
availability failures with delays capped at 32 seconds; an authenticated Relay
registration refusal waits for explicit reconfiguration. Commands/data are never
replayed by this layer. Public Relay deployments still need operational abuse
limits and independent security review.

## Mobile custody and recovery

Scan (or paste) a QR generated by the desktop Relay settings. Mobile displays the
pinned computer key and endpoint and creates a new Noise identity inside its
existing secure credential backend. Camera scanning automatically supplies a
phone label and completes authorization/connection; manual paste retains an
explicit submit step. A disabled profile
holding only the opaque credential handle/public metadata is saved before sending
any pairing handshake. Only the native authenticated approval enables the profile;
new desktop QR invitations provide it automatically after persisting the phone's
exact identity. A cancelled or lost exchange can still retain a disabled profile:
use Check existing authorization to reconcile rather than locally toggling trust.

Cancel/unknown results retain the profile and key. In host editing, **Check existing
authorization** performs a fresh authenticated probe with that exact retained key
and pinned computer; it cannot grant permission on the computer. Alternatively,
revoke on the computer before deleting the local profile/key. Deleting a local
profile disconnects it but does not revoke its remote authorization. Metadata-only
exports contain no device private key or credential handle; imported Relay profiles
remain disabled and require a new scan. Copying a Relay profile is rejected rather
than silently sharing its device identity. Existing SSH exports/imports retain their
prior semantics.

Mobile Relay connections use the same framed Bridge hello, requests, subscriptions,
generation ownership and unknown-write rules as SSH. A separate transport owner
cancels the encrypted pump even if split reader/writer halves are still retained.
An authenticated refusal from the computer stops reconnect retries; availability
failures use the existing capped-delay retry loop. Neither path replays uncertain
commands/input or restarts a Session automatically.
