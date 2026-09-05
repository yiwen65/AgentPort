> Historical SSH QR implementation. The active UI now uses full Relay; see `crates/agentport-relay/README.md` and T-007–T-010 in the reliability task document. Existing SSH authorizations are not migrated or removed.

# First-time phone pairing: security and operation

Scope: iOS Mobile + macOS desktop; implemented for the confirmed U7 contract in
`2026-09-05-mobile-session-reliability-pairing-task.md`.

## Operation

1. Enable macOS Remote Login yourself and allow your current account. AgentPort
   does not enable SSH, obtain root, change firewall/router settings or use a relay.
2. In desktop Settings → Phone Pairing, enter an address reachable from your
   phone and generate a QR code. The SSH target is the current local account,
   port 22, with the system Ed25519 host-key fingerprint.
3. In Mobile host management, choose Scan to pair, then name the phone and request
   authorization. Compare both verification codes/device names and authorize on
   the desktop only if they match. Codes grant Session-management access through
   the restricted Remote Bridge command; do not share/screenshot live QR codes.
4. After Mobile saves the approval, choose Connect on its new host row. Connection
   failures can be retried without generating or sharing another key.
5. Settings → Phone Pairing → Revoke access removes only the matching app-marked
   authorization, after confirmation. It blocks **new** SSH authentication; an
   already authenticated SSH connection can remain active. Moving/deleting the
   desktop App can invalidate the pinned absolute Remote Bridge command path.

## Trust and custody

- QR contains a 256-bit random **ephemeral capability**, invitation ID, endpoints,
  SSH target/fingerprint and expiry (120 seconds); never an SSH password/private key.
- This capability is the trust bootstrap, not an untrusted URL. Length-prefixed TCP
  requests/replies use AES-256-GCM, random 96-bit nonces and AAD binding v1,
  invitation ID and direction. There is no plaintext HTTP authorization endpoint.
- One exact request ID/name/Ed25519 public key claims a code. Desktop approval binds
  that candidate, with an 8-hex-digit comparison code and SHA256 key fingerprint.
  Approved polling is idempotent until expiry; another candidate cannot claim it.
- Invalid authentication/replay/oversized frames fail closed. 512 accepted sockets,
  256 authenticated nonces, absolute 3-second frame-read deadlines, bounded IO,
  expiry and cancellation bound listener resources. A local peer can still deny
  availability; pairing is not a public internet service. DNS uses the OS resolver
  and has no separate deadline; prefer the local IP offered by the desktop.
- Phone generates a **new** Ed25519 key in its existing secure credential backend.
  It persists a disabled profile referencing that key before any request is sent.
  Authenticated approval must exactly match the QR target before trust is saved and
  the profile is enabled. Secret QR content is not persisted/logged by the app.
- Cancelled/unknown/failed pairing retains the disabled pending profile/key rather
  than deleting a potentially authorized credential. Check/revoke desktop access,
  then explicitly delete the pending profile and its credential. A profile-save
  failure with unknown persistence can retain an unreferenced new credential;
  this favors key custody over destructive automatic cleanup.
- Native authorization checks owned non-symlink SSH directory, regular owned
  single-link files, safe permissions and 1 MiB limits. App writers use a checked
  flock file; writes stage at 0600, fsync and atomically rename after rechecking
  source bytes. Unrelated keys are preserved. External tools need not honor the
  lock: there remains a check-to-rename race with an arbitrary same-user writer.
- Authorization uses `restrict,command="'<absolute bridge>' serve --stdio"` and a
  precise app marker. No general shell/PTY/agent/port/X11 forwarding is granted.
  Revocation requires exact marker ID + expected fingerprint. Duplicate marked
  fingerprints are rejected. Custom sshd AuthorizedKeysFile/Match rules and
  nonstandard host-key algorithms are not configured automatically.

## Verification boundary

- Shared crate tests use temporary directories and encrypted loopback only; no
  writes to real `~/.ssh/authorized_keys`, no existing credential replacement.
- Mobile tests cover invalid/expired preview before key generation, disabled
  custody, exact approval, failed trust, cancellation/late reply, camera denial,
  reachable scan cancellation and success. Desktop tests cover explicit bound
  approval, confirmed revocation and late-start cleanup.
- System SSH port 22 is unavailable on this development Mac (`nc -z -w 2
  127.0.0.1 22`, exit 1). Real first-time SSH onboarding is therefore blocked here;
  the existing simulator debug SSH listener is not a substitute for that claim.
- Simulator builds do not verify a physical camera or Android. iOS simulator
  camera-unavailable behavior and nonblank application renders are checked separately.

## Implementation checks discovered during this stage

- Official scanner 2.4.6 full-screen iOS mode inserts native camera above the
  webview without cancel controls. Windowed mode plus transparent preview surface
  keeps the app's Cancel/Close controls reachable; unmount cancels the native scan.
- `@types/qrcode` pulls Node ambient types into the browser frontend, invalidating
  existing Node-only test shims. A browser-only API declaration avoids unrelated
  test rewrites.
- Darwin can reject a near-whole-second socket timeout after microsecond rounding;
  deadline updates use whole milliseconds while keeping an absolute frame budget.
