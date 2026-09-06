# Relay scan-to-connect

Status: done (implementation, isolated integration and device installation).

## User-approved behavior

The user explicitly requested one-time desktop Relay URL/token configuration, QR generation, and phone scan-to-connect without a second approval. Generating the short-lived QR now grants enrollment authority to its first authenticated holder. This supersedes the old mandatory comparison/desktop approval UX for newly generated invitations.

## Implementation and security boundary

- New InviteAutomatic IPC is explicit and fails on an old connector rather than silently falling back to a pending invitation. Legacy Invite/Decide retain manual approval semantics for compatibility/tests.
- First fully Noise-authenticated candidate claims the invitation. Automatic mode reuses the exact invitation/request/device-key/expiry checks and durable device allowlist transaction. No success if storage fails. Wrong secrets, used invites and revoked keys remain rejected.
- QR remains 120-second, one-time bearer access. Deployment registration token and endpoint static private keys remain absent. No local enabled flag bypass. Device revocation remains available.
- Camera scan validates QR then prepares native key custody, waits for authenticated approval, and automatically connects the exact approved profile. Manual paste retains explicit submit. Cancellation/unknown outcomes retain pending identity for authenticated reconciliation.
- Removed comparison/approval UI from the new desktop/mobile path, with bearer-access warnings in English/Chinese.

## Verification and delivery

- Relay: 22 library tests passed, 1 optional integration test ignored in default suite, 1 CLI test passed. New tests cover automatic approval, wrong PSK, one-time use, encrypted traffic, revocation and storage failure.
- Optional real Bridge hello/project.list test changed to automatic enrollment and passed in isolated empty data root; no existing Session input.
- Mobile: 177 tests passed; desktop PairingSection: 5 tests passed. Type/frontend builds and Relay strict clippy passed (Homebrew toolchain; rustup clippy is unavailable).
- Signed desktop debug and physical iPhone arm64 builds passed. Installed and launched com.agentport.mobile on the paired iPhone; did not uninstall or clear profiles.
- Replaced only current checkout connector PID 32638 after exact executable/socket ownership verification and graceful private IPC Stop. It had zero active channels. New PID 31690 reports connected; existing URL/token/identities retained. No Session Host stopped.
- Reopened exact debug GUI PID 32239; screenshot of its own window inspected, normally rendered. User-generated QR is visible; no automatic test consumed it. Physical scan/public-network end-to-end success is not claimed.
- Evidence /tmp/ap-auto-pair/. Preserve original four dirty files plus user's Xcode team/scheme changes; no credentials committed.
