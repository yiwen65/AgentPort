# Linux review deployment

Deployment status and Apple cutover evidence belong to
`docs/tasks/2026-09-09-testflight-review-access-task.md` (repository root).
This directory supplies the runtime image and its supervisor, not a desktop GUI.

## Boundaries

- Run only a dedicated review container, as UID/GID 1550. Mount only its own
  named HOME volume. Never mount a personal HOME, SSH keys, provider credentials,
  host sockets, or the Docker socket. Do not use privileged or host networking.
- The shell can inspect and alter its own demo files and credentials. The
  container shares the host kernel and has outbound network access; this is not
  a VM or protection against all kernel/network attacks.
- Only host loopback ports 43867/43868 are published. Tailscale Funnel supplies
  public HTTPS/WSS; leave existing FRP, nginx, proxy and business services alone.
- Use a private per-container DBus session and encrypted GNOME Secret Service.
  Its random unlock password and Relay token stay in the review volume; neither
  belongs in Apple review information. No plaintext keyring fallback is added.
- The supervisor exits if a critical child exits; Docker `unless-stopped`
  restarts it. Startup unlocks the persistent keyring, reuses connector identity
  and devices, reconciles sessions and creates a demo Shell when none is live.
  A reboot cannot preserve a live shell process; pairing identity does persist.

## Build

On Ubuntu 24.04 x86_64, from a clean source checkout:

```sh
CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 cargo build --locked \
  -p agentport-cli -p agentport-host -p agentport-remote-bridge \
  -p agentport-relay --features agentport-relay/connector,agentport-relay/server
mkdir -p /path/to/private-image-context/bin
cp target/debug/agentport-{cli,host,remote-bridge,connector,relay} /path/to/private-image-context/bin/
cp mobile/scripts/review-linux/{Dockerfile,supervisor.py} /path/to/private-image-context/
cp mobile/scripts/review_{gateway,access_control}.py /path/to/private-image-context/
docker build -t agentport-review-linux:20260909 /path/to/private-image-context
```

The observed server's existing Docker mirror/proxy could not fetch Ubuntu.
Without changing that global configuration, the deployment instead imported
Ubuntu's official `ubuntu-base-24.04.4-base-amd64.tar.gz`, downloaded directly
from `https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/` and verified
against its HTTPS SHA256SUMS:
`c1e67ef7b17a6300e136118bd1dc04725009cb376c1aad10abcf8cd453628d58`.
The imported base tag was `agentport-review-ubuntu-base:24.04.4`; build with
`--build-arg BASE_IMAGE=agentport-review-ubuntu-base:24.04.4` to use it.
This is a reproducible source reference, not an assertion that the image will
remain patched indefinitely. Review/rebuild security updates as needed.

## Provision and run

Create the task-owned volume `agentport-review-home`. Before first startup,
provision `/home/agentportreview` and its `review/` subdirectory as 1550:1550,
0700. Provision `review/website-credentials.txt` as 1550:1550, 0600 with
`Username: ...` and `Password: ...` lines, through private stdin or a protected
local file, never command arguments/logs. During migration use the existing
**website** login already supplied to Apple, not the OS or Relay credentials.
Provisioning must refuse an existing setup rather than overwrite secrets.

```sh
docker run -d --name agentport-review-linux --restart unless-stopped --init \
  --user 1550:1550 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 256 --memory 1g --cpus 1 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m \
  --mount type=volume,src=agentport-review-home,dst=/home/agentportreview \
  -p 127.0.0.1:43867:43869 -p 127.0.0.1:43868:43868 \
  -e REVIEW_ORIGIN=https://linux.tailbb155a.ts.net \
  --log-opt max-size=5m --log-opt max-file=2 agentport-review-linux:20260909
```

Do not rerun this over an existing named container. A root filesystem/image
change requires controlled recreation; do not delete the persistent volume.
The container-only socat forwarder preserves the gateway's loopback-only
binding; Docker exposes the forwarder on **host loopback**, not all interfaces.

After verifying local service health and inspecting existing Funnel routes:

```sh
sudo tailscale funnel --bg --https=443 http://127.0.0.1:43867
sudo tailscale funnel --bg --https=443 --set-path=/v1/relay http://127.0.0.1:43868/v1/relay
```

Use the review-user status command without printing secret configuration:

```sh
docker exec agentport-review-linux python3 /opt/agentport/review_access_control.py \
  --config /home/agentportreview/review/gateway.json status
```

## Acceptance and lifetime

- Run `python3 mobile/scripts/test-review-gateway.py` on macOS and Linux.
- Verify unauthenticated HTTPS 401, authenticated GET/POST, strict Origin/CSRF,
  public WSS pairing, actual Bridge results (not only `accepted` envelopes),
  terminal input/output, and revoked-identity rejection.
- For initial recovery acceptance only, create `review/acceptance-no-shell`
  before first startup. Pair a temporary device; ensure no Host/session has
  started, remove the marker, then restart only the new container. Verify the
  same device reconnects and a fresh Review Terminal appears. This tests keyring
  and service restart without terminating any existing Host. Do not repeat a
  restart over active user sessions without authorization.
- Docker and tailscaled are enabled at boot on the observed server. Actual
  whole-server reboot was not tested because it would interrupt existing work.
- Initial website access lasts **7 days**, maximum 3 devices and 30 issuance
  attempts. Restart does not extend expiry or reset the budget. Monitor/extend
  the private deadline before it expires if Apple review is still pending.
  Website expiry does not revoke already paired devices.
- On shutdown, remove only task-owned Funnel routes, then use the local
  `revoke-all` operation as documented in `mobile/REVIEW_ACCESS.md`. Never use a
  whole-port reset if unrelated routes have since been added.
