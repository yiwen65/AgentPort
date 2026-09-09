#!/usr/bin/env python3
"""Dedicated container only: persistent demo identity, private DBus and supervision.

Provision website-credentials.txt (Username/Password lines) in the private HOME
before starting. Never mount personal HOME, Docker socket, or host credentials.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import time

from review_gateway import Unavailable, ipc

os.umask(0o077)
runtime_dir = Path('/tmp/agentport-review-runtime')
runtime_dir.mkdir(mode=0o700, exist_ok=True)
os.environ['XDG_RUNTIME_DIR'] = str(runtime_dir)
home = Path.home()
root = home / 'review'
root.mkdir(mode=0o700, exist_ok=True)
data = Path(os.environ['AGENTPORT_DATA_DIR'])
data.mkdir(mode=0o700, exist_ok=True)
bin_dir = Path('/opt/agentport/bin')
children = []


def launch(args, **kwargs):
    # Don't log argv/config/IPC contents: they may carry credentials.
    process = subprocess.Popen(args, **kwargs)
    children.append(process)
    return process


def run_cli(*args):
    result = subprocess.run([str(bin_dir / 'agentport-cli'), '--json', *args],
                            capture_output=True, timeout=30, check=True)
    return json.loads(result.stdout)


def secret_file(name):
    path = root / name
    if not path.exists():
        with path.open('x') as f:
            f.write(secrets.token_hex(32))
    return path


def terminate(signum, frame):
    # Only this dedicated container's children. Never host-wide PID matching.
    for process in reversed(children):
        if process.poll() is None:
            process.terminate()
    raise SystemExit(0)


signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
keyring = launch(['gnome-keyring-daemon', '--foreground', '--components=secrets', '--unlock'],
                 stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
keyring.stdin.write(secret_file('keyring-password').read_bytes())
keyring.stdin.close()
time.sleep(2)
if keyring.poll() is not None:
    raise RuntimeError('Dedicated Secret Service failed')

namespace = base64.urlsafe_b64encode(hashlib.sha256(json.dumps(
    [str(bin_dir.resolve()), str(data.resolve())], separators=(',', ':')).encode()).digest()).decode().rstrip('=')[:20]
socket_dir = '/tmp/agentport-relay-' + str(os.getuid()) + '-' + namespace
origin = os.environ['REVIEW_ORIGIN']
credential_file = root / 'website-credentials.txt'
credentials = dict(line.split(':', 1) for line in credential_file.read_text().splitlines() if ':' in line)
config_file = root / 'gateway.json'
if config_file.exists():
    config = json.loads(config_file.read_text())
    if config['origin'] != origin or config['socket_directory'] != socket_dir:
        raise RuntimeError('Deployment identity/config drift; operator inspection required')
else:
    config = dict(origin=origin, relay_url=origin.replace('https:', 'wss:') + '/v1/relay',
                  connector_relay_url='ws://127.0.0.1:43868/v1/relay',
                  username=credentials['Username'].strip(),
                  password_sha256=hashlib.sha256(credentials['Password'].strip().encode()).hexdigest(),
                  expires_at=int(time.time()) + 7 * 86400, max_devices=3, max_invitations=30,
                  state_path=str(root / 'issuance.json'), socket_directory=socket_dir, port=43867)
    config_file.write_text(json.dumps(config))

relay_token = secret_file('relay-token')
launch([str(bin_dir / 'agentport-relay'), '--bind', '0.0.0.0:43868', '--host-token-file', str(relay_token)])
launch([str(bin_dir / 'agentport-connector'), '--data-dir', str(data)])
for attempt in range(30):
    try:
        status = ipc(socket_dir, {'kind': 'status'})['status']
        break
    except (OSError, ValueError, Unavailable):
        time.sleep(1)
else:
    raise RuntimeError('Connector did not start')
if status['phase'] == 'unconfigured':
    ipc(socket_dir, dict(kind='configure', relay_url=config['connector_relay_url'],
                         name='AgentPorts Linux Review Demo', token=relay_token.read_text().strip()))
for attempt in range(30):
    status = ipc(socket_dir, {'kind': 'status'})['status']
    if status['phase'] == 'connected':
        break
    time.sleep(1)
else:
    raise RuntimeError('Connector did not connect')

demo = home / 'AgentPort-Demo'
demo.mkdir(exist_ok=True)
readme = demo / 'README.txt'
if not readme.exists():
    readme.write_text('Welcome to the AgentPorts Linux review demo.\nThis is a real isolated shell terminal. Try pwd, ls and cat README.txt.\nNo paid AI-provider credentials or personal data are included.\n')
project = run_cli('project', 'add', str(demo), '--name', 'Review Demo')
run_cli('probe', 'shell', '--path', '/bin/sh')
run_cli('reconcile')
sessions = run_cli('session', 'list')
# A server/container reboot ends shells, not persisted pairing identities.
# Keep live sessions, otherwise create a fresh demo terminal.
if not (root / 'acceptance-no-shell').exists() and not any(
        s.get('projectId') == project['id'] and s.get('lifecycle') == 'running' for s in sessions):
    run_cli('session', 'new', '--project', project['id'], '--agent', 'shell',
            '--title', 'Review Terminal', '--permission', 'native')
launch(['python3', '/opt/agentport/review_gateway.py', '--config', str(config_file)])
# Keep the gateway loopback-only. Docker publishes this container-only forwarder
# exclusively on host 127.0.0.1; do not publish it on all host interfaces.
launch(['socat', 'TCP-LISTEN:43869,bind=0.0.0.0,reuseaddr,fork,max-children=16', 'TCP:127.0.0.1:43867'])
print('Review services ready', flush=True)
while True:
    if any(process.poll() is not None for process in children):
        raise RuntimeError('A review service exited; container restart required')
    time.sleep(2)
