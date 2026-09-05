# AgentPort Relay (v1)

Self-hosted, bounded WebSocket routing for native AgentPort endpoints. Both
computer and phone make outbound connections; the phone does not need a route
to the computer, and SSH is not part of this transport.

**Integration status:** this crate currently supplies routing, Noise handshakes
and an encrypted Tokio byte stream. Desktop background authorization, Mobile
profile integration and QR UI replacement are tracked in T-008–T-010 of
[`mobile-session-reliability-pairing-task.md`](../../docs/tasks/2026-09-05-mobile-session-reliability-pairing-task.md).
The existing apps do not yet use this transport. Do not treat the server alone
as a complete pairing/authorization system.

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
- The endpoint connector must enforce one authenticated candidate per invitation,
  explicit desktop approval, durable authorization, expiry, and revocation.
  Revocation must first persist removal and close that device's current channels,
  not stop Session Hosts. Those application guarantees are not implemented by
  blind routing and must be verified at the connector integration boundary.
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
cargo test -p agentport-relay --features server
cargo clippy -p agentport-relay --all-targets --features server -- -D warnings
cargo fmt -p agentport-relay --check
```

Tests use fresh identities, temporary files and ephemeral loopback listeners;
no existing credentials, SSH configuration, or user Sessions are accessed.
Coverage includes pinning before identity disclosure, tampering/replay/wrong PSK,
registration challenge binding, cross-computer Accept isolation, generation
replacement, queue/socket/frame limits, private token files, and bidirectional
multi-chunk encrypted streams (including flush-before-drop).
