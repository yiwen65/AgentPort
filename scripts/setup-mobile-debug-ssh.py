#!/usr/bin/env python3
"""Install a login-persistent, loopback-only SSH endpoint for Mobile Simulator.

The client private key stays in Mobile's Keychain. Supply only its public key.
Rerunning preserves the server identity and authorized public key unless a new
--public-key is explicitly supplied. No system sshd or ~/.ssh files are changed.
"""
import argparse
import os
from pathlib import Path
import plistlib
import pwd
import shlex
import socket
import subprocess
import sys
import time

LABEL = "com.agentport.mobile-debug-ssh"
PORT = 51222


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def write_private(path, content, mode=0o600):
    path.write_text(content)
    path.chmod(mode)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-key", type=Path, help="Mobile's generated Ed25519 public key file")
    args = parser.parse_args()
    if sys.platform != "darwin" or os.getuid() == 0:
        parser.error("Run as the logged-in macOS user, not root.")
    os.umask(0o077)
    home = Path.home()
    root = Path(__file__).resolve().parent.parent
    bridge = root / "target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport-remote-bridge"
    if not bridge.is_file() or not os.access(bridge, os.X_OK):
        parser.error("Build the debug App first: bash scripts/rebuild-debug-app.sh")
    state = home / ".local/share/agentport-mobile-debug"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    authorized = state / "authorized_keys"
    if args.public_key:
        # Validate a bare public key; do not accept injected authorized_keys options.
        parts = args.public_key.read_text().strip().split()
        if len(parts) < 2 or parts[0] != "ssh-ed25519":
            parser.error("Expected an Ed25519 public key, never a private key.")
        run("/usr/bin/ssh-keygen", "-lf", str(args.public_key), stdout=subprocess.DEVNULL)
        write_private(authorized, f"restrict {parts[0]} {parts[1]}\n")
    if not authorized.is_file():
        parser.error("First run requires --public-key from Mobile's Generate Ed25519 key action.")
    key = state / "host_ed25519"
    if not key.exists():
        run("/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key))
    key.chmod(0o600)
    # Never depend on an interactive shell's PATH or a temporary fixture DB.
    wrapper = state / "bridge.sh"
    write_private(wrapper, "#!/bin/sh\nset -eu\n"
        'if [ "${SSH_ORIGINAL_COMMAND:-}" != "agentport-remote-bridge serve --stdio" ]; then\n'
        '  echo "Only AgentPort Remote Bridge is allowed" >&2; exit 126\nfi\n'
        f"export AGENTPORT_DATA_DIR={shlex.quote(str(home / 'Library/Application Support/AgentPort'))}\n"
        "unset AGENTPORT_SOCKET_DIR\n"
        'export TMPDIR="$(/usr/bin/getconf DARWIN_USER_TEMP_DIR)"\n'
        f"export PATH={shlex.quote(str(bridge.parent) + ':/usr/bin:/bin:/usr/sbin:/sbin')}\n"
        f"exec {shlex.quote(str(bridge))} serve --stdio\n", 0o700)
    config = state / "sshd_config"
    # OpenSSH config paths need double quotes (macOS home paths can contain spaces).
    def quote(path):
        return '"' + str(path).replace('\\', '\\\\').replace('"', '\\"') + '"'
    write_private(config, f"""Port {PORT}
ListenAddress 127.0.0.1
HostKey {quote(key)}
PidFile {quote(state / 'sshd.pid')}
AuthorizedKeysFile {quote(authorized)}
AllowUsers {pwd.getpwuid(os.getuid()).pw_name}
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
UsePAM no
StrictModes yes
DisableForwarding yes
PermitTTY no
PermitUserRC no
ForceCommand {shlex.quote(str(wrapper))}
LogLevel INFO
""")
    run("/usr/sbin/sshd", "-t", "-f", str(config))
    agent = home / "Library/LaunchAgents" / f"{LABEL}.plist"
    agent.parent.mkdir(parents=True, exist_ok=True)
    domain = f"gui/{os.getuid()}"
    service = f"{domain}/{LABEL}"
    installed = subprocess.run(["/bin/launchctl", "print", service],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not installed:
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", PORT))
            except OSError:
                parser.error(f"Port {PORT} is already in use; refusing to replace another service.")
    agent.write_bytes(plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": ["/usr/sbin/sshd", "-D", "-e", "-f", str(config)],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": str(state / "sshd.log"),
        "StandardErrorPath": str(state / "sshd.log"),
        "WorkingDirectory": str(home),
    }))
    agent.chmod(0o600)
    if installed:
        run("/bin/launchctl", "kickstart", "-k", service)
    else:
        run("/bin/launchctl", "bootstrap", domain, str(agent))
    for _ in range(30):
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=1) as connection:
                if connection.recv(128).startswith(b"SSH-2.0-"):
                    break
        except OSError:
            pass
        time.sleep(0.2)
    else:
        raise RuntimeError(f"sshd did not start; inspect {state / 'sshd.log'}")
    print(f"Ready: {pwd.getpwuid(os.getuid()).pw_name}@127.0.0.1:{PORT}")
    print(f"Persistent state: {state}\nLogin service: {agent}")
    run("/usr/bin/ssh-keygen", "-lf", str(key.with_suffix(".pub")))


if __name__ == "__main__":
    main()
