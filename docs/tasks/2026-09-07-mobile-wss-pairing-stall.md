# Mobile WSS pairing stall and return-to-dashboard

Status: done.

## Evidence and root cause

Physical iPhone stayed indefinitely on the pairing preparation screen. Read-only device metadata showed an unapproved/disabled new profile; desktop showed no candidate. Temporary debug-only stage instrumentation reached `begin.network`, not credential storage. That instrumentation has been removed from source.

A new isolated WSS regression reproduced a rustls CryptoProvider panic with the pre-fix Relay dependency graph. Mobile's rustls dependency had no selected cryptographic backend; local plain WS integration tests did not exercise TLS initialization. Panic dropped the native pairing task without resolving the frontend invoke, so neither normal network timeouts nor error UI could complete. The disabled profile was the safety-preserving outcome of incomplete authorization, not the originating failure.

## Fix

- Relay explicitly builds each TLS connection with ring provider, WebPKI root store and safe protocol versions. Does not depend on a process-global implicit provider or relax certificate/hostname checks.
- Added non-TLS-peer WSS regression (must return Err rather than panic) and opt-in trusted public WSS upgrade probe (no enrollment, token or Session request).
- After authenticated pairing AND successful RemoteClient.connect, close device manager, select the exact newly connected computer and return to its Session dashboard. Do not navigate on connection failure.
- During pairing show compact Connecting progress, not the explanatory Pair with a computer form or misleading disabled-profile text. Desktop authorization status no longer asks for another phone action.

## Verification

- Baseline WSS test failed with `Could not automatically determine the process-level CryptoProvider`; fixed test passes.
- Relay suite: 23 library tests plus 1 CLI pass; optional tests excluded from default run. Explicit public WSS upgrade to the configured Relay passed with certificate validation intact.
- Mobile 178 tests pass, including scan/connection/navigation/new host selection. Frontend, physical arm64 iPhone build and signed debug desktop builds pass; strict Relay clippy passes.
- Installed and launched updated iPhone app without deleting data. After the user's new scan, read-only device profile shows Relay approved=true/enabled=true/no lastError; desktop status shows one allowed phone and one active channel. No test entered or restarted an existing Session.
- Exact debug GUI path confirmed and its nonblank own-window screenshot inspected. Temporary runtime marker file contains only a timestamp/stage, no credentials. Evidence /tmp/ap-pair-stall/.
- Full phone UI/terminal acceptance beyond observed authorization/channel and component navigation tests remains user-driven. Existing dirty files and Xcode signing settings preserved.
