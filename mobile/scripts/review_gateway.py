#!/usr/bin/env python3
"""Mac-only, isolated review-host pairing portal. No generic command/IPC endpoint.

Run as the dedicated review account, behind a TLS proxy, on loopback only.
A review Host intentionally grants terminal execution as that account. This
portal is NOT a sandbox against an already authorized terminal user.
"""
import argparse
import base64
import collections
import ctypes
import hashlib
import hmac
import html
import http.server
import json
import os
from pathlib import Path
import pwd
import secrets
import socket
import stat
import struct
import threading
import time
import urllib.parse


class Unavailable(Exception):
    pass


def private_path(path, directory=False):
    path = Path(path)
    info = path.lstat()
    valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not path.is_absolute() or not valid_type or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Expected a private, same-user path")
    return path


def ipc(directory, request):
    directory = private_path(directory, directory=True)
    target = directory / "control.sock"
    info = target.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Unavailable("Unsafe connector socket")
    payload = json.dumps(request).encode()
    if len(payload) > 8192:
        raise Unavailable("Request too large")
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(5)
        s.connect(str(target))
        # macOS getpeereid: don't trust a pathname check alone.
        uid, gid = ctypes.c_uint(), ctypes.c_uint()
        if ctypes.CDLL(None).getpeereid(s.fileno(), ctypes.byref(uid), ctypes.byref(gid)) or uid.value != os.getuid():
            raise Unavailable("Wrong connector owner")
        s.sendall(struct.pack("!I", len(payload)) + payload)
        def receive(n):
            result = bytearray()
            while len(result) < n:
                chunk = s.recv(n - len(result))
                if not chunk:
                    raise Unavailable("Incomplete connector response")
                result.extend(chunk)
            return bytes(result)
        size = struct.unpack("!I", receive(4))[0]
        if not 0 < size <= 65536:
            raise Unavailable("Invalid response length")
        response = json.loads(receive(size))
        if response.get("kind") == "error":
            raise Unavailable("Connector rejected request")
        return response


class Portal:
    def __init__(self, config, call=None, clock=time.time):
        self.config = config
        origin = urllib.parse.urlsplit(config["origin"])
        if origin.scheme != "https" or not origin.hostname or origin.path or origin.query or origin.fragment or origin.username is not None:
            raise ValueError("Expected an HTTPS origin")
        external = urllib.parse.urlsplit(config["relay_url"])
        if external.scheme != "wss" or external.netloc != origin.netloc or external.path != "/v1/relay" or external.query or external.fragment:
            raise ValueError("Demo WSS must use the approved HTTPS origin")
        if config.get("connector_relay_url"):
            internal = urllib.parse.urlsplit(config["connector_relay_url"])
            if internal.scheme != "ws" or internal.hostname not in ("127.0.0.1", "::1") or internal.path != "/v1/relay" or internal.username is not None or internal.query or internal.fragment:
                raise ValueError("The internal demo Relay must use literal loopback")
        self.host = origin.netloc
        self.clock = clock
        self.call = call or (lambda request: ipc(config["socket_directory"], request))
        self.lock = threading.Lock()
        self.failures = collections.deque(maxlen=40)
        self.csrf = secrets.token_urlsafe(32)
        self.invitation = None
        self.state_path = Path(config["state_path"])
        private_path(self.state_path.parent, directory=True)
        if self.state_path.exists():
            private_path(self.state_path)
            self.issued = json.loads(self.state_path.read_text())["issued"]
        else:
            self.issued = 0
        self.last_attempt = 0

    def authenticate(self, header):
        with self.lock:
            now = self.clock()
            while self.failures and self.failures[0] <= now - 60:
                self.failures.popleft()
            if now >= self.config["expires_at"]:
                return 410
            try:
                scheme, encoded = header.split(" ", 1)
                if scheme.lower() != "basic":
                    raise ValueError()
                raw = base64.b64decode(encoded, validate=True)
                username, password = raw.decode().split(":", 1)
                accepted = hmac.compare_digest(username, self.config["username"]) and hmac.compare_digest(
                    hashlib.sha256(password.encode()).hexdigest(), self.config["password_sha256"])
            except (ValueError, UnicodeError):
                accepted = False
            # Anonymous failures must not lock out a reviewer who already has
            # the correct high-entropy credential (e.g. shared proxy address).
            if accepted:
                return 200
            if len(self.failures) >= 40:
                return 429
            self.failures.append(now)
            return 401

    def issue(self):
        with self.lock:
            now = self.clock()
            if now >= self.config["expires_at"]:
                raise Unavailable("Review access has expired")
            status = self.call({"kind": "status"})["status"]
            if status["phase"] != "connected":
                raise Unavailable("Demo computer is offline; please retry later")
            if len(status["devices"]) >= self.config["max_devices"]:
                raise Unavailable("Review device limit reached; contact the developer")
            pairing = status.get("pairing")
            if self.invitation and self.invitation["expiresAt"] > now + 10 and pairing and pairing["invitationId"] == self.invitation["id"] and pairing["phase"] == "waiting":
                return self.invitation
            # A timed-out prior mutation may still have created a code. Don't
            # replay it or invalidate another visitor's still-live invitation.
            if pairing and pairing["phase"] in ("waiting", "pending") and pairing["expiresAt"] > now:
                raise Unavailable("A pairing is in progress; retry after its two-minute window")
            if self.issued >= self.config["max_invitations"] or now - self.last_attempt < 5:
                raise Unavailable("Pairing request limit reached; please retry later or contact the developer")
            self.issued += 1
            self.last_attempt = now
            # Reserve the attempt durably BEFORE asking the connector to mutate.
            temporary = self.state_path.with_name(self.state_path.name + ".new")
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump({"issued": self.issued}, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temporary, self.state_path)
            invitation = self.call({"kind": "invite_automatic"})["invitation"]
            if not now < invitation["expiresAt"] <= now + 130:
                raise Unavailable("Invalid invitation expiry")
            if invitation["peer"]["relayUrl"] != self.config.get("connector_relay_url", self.config["relay_url"]):
                raise Unavailable("Unexpected demo Relay; stopped")
            # The computer uses the same demo Relay over loopback; the phone
            # uses its TLS reverse-proxy address. Preserve host/key/id/PSK/TTL.
            # Noise authenticates the pinned host key and host/id context,
            # not the network address (crypto.rs Handshake::pair/session).
            invitation = dict(invitation, peer=dict(invitation["peer"], relayUrl=self.config["relay_url"]))
            self.invitation = invitation
            return invitation


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8
    def __init__(self, address, portal):
        if address[0] != "127.0.0.1":
            raise ValueError("Loopback binding required")
        self.portal = portal
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, Handler)

    def get_request(self):
        s, address = super().get_request()
        s.settimeout(5)
        return s, address

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, request, address):
        pass  # No request details, headers or invitation text in logs.


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "ReviewGateway"
    sys_version = ""
    def log_message(self, *args):
        pass

    def reply(self, status, message, invitation=None):
        p = self.server.portal
        code = ""
        if invitation:
            value = html.escape(json.dumps(invitation, separators=(",", ":")))
            code = '<label for="code">One-time connection code</label><textarea id="code" readonly rows="10" spellcheck="false">' + value + '</textarea><p>Copy the entire code and pair within two minutes. Never share it.</p>'
        form = ('<form method="post" action="/invite"><input type="hidden" name="csrf" value="' + p.csrf + '"><button>Get connection code</button></form>') if status == 200 else ''
        body = ('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                '<title>AgentPorts review access</title><style>body{font:17px/1.5 system-ui,sans-serif;max-width:42rem;margin:0 auto;padding:24px;color:#18202a;background:#f7f8fa}h1{font-size:1.65rem}button{font:inherit;background:#1554a3;color:white;border:0;border-radius:8px;min-height:48px;padding:10px 18px}textarea{box-sizing:border-box;width:100%;font:15px/1.5 monospace;padding:12px;margin-top:8px}button:focus-visible,textarea:focus-visible{outline:3px solid #963e00;outline-offset:3px}</style>'
                '<main><h1>AgentPorts review access</h1><p>' + html.escape(message) + '</p>' + code + form +
                '<h2>Connect from TestFlight</h2><ol><li>Install AgentPorts in TestFlight.</li><li>In the app, open device management, then Scan to pair.</li><li>Choose No camera? Paste pairing code, paste the entire code, validate it and connect.</li></ol>'
                '<p>This computer contains demo data only. No personal account is required. This is a real remote terminal, not a simulated screen.</p>'
                '<p>The website login expiry does not revoke an already paired device. The developer must revoke devices or shut down the demo environment separately.</p><p><a href="/">Reload the review page</a></p></main></html>').encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # no-referrer makes navigation POST Origin null in browsers. Keep
        # same-origin form provenance without sending Referer cross-origin.
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.send_header("Strict-Transport-Security", "max-age=86400")
        if status == 401:
            self.send_header("WWW-Authenticate", 'Basic realm="AgentPorts review", charset="UTF-8"')
        if status == 429:
            self.send_header("Retry-After", "60")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if self.headers.get("Host") != self.server.portal.host:
            self.reply(400, "Invalid host")
            return False
        status = self.server.portal.authenticate(self.headers.get("Authorization", ""))
        if status != 200:
            self.reply(status, {401: "Sign in with the review credentials supplied in App Store Connect.", 429: "Too many sign-in attempts. Try again in one minute.", 410: "Review access has expired. Contact the developer."}[status])
            return False
        return True

    def do_GET(self):
        if not self.authorized():
            return
        if self.path != "/":
            self.reply(404, "Not found")
            return
        self.reply(200, "Use the button to obtain a fresh, short-lived connection code for the isolated demo computer.")

    def do_POST(self):
        if not self.authorized():
            return
        if self.path != "/invite":
            self.reply(404, "Not found")
            return
        if self.headers.get("Origin") != self.server.portal.config["origin"]:
            self.reply(403, "Invalid request origin")
            return
        try:
            if self.headers.get("Transfer-Encoding"):
                raise ValueError()
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 256 or self.headers.get_content_type() != "application/x-www-form-urlencoded":
                raise ValueError()
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError()
            fields = urllib.parse.parse_qs(raw.decode(), strict_parsing=True, max_num_fields=2)
        except (ValueError, UnicodeError):
            self.reply(400, "Invalid form")
            return
        if fields != {"csrf": [self.server.portal.csrf]}:
            self.reply(403, "Reload the page and try again")
            return
        try:
            invitation = self.server.portal.issue()
        except (Unavailable, OSError, ValueError, KeyError, TypeError):
            self.reply(503, "Pairing is unavailable, busy, or at its review limit. Wait two minutes and try again. If it persists, contact the developer.")
            return
        self.reply(200, "The code grants access only to the demo computer.", invitation)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(private_path(args.config).read_text())
    if pwd.getpwuid(os.getuid()).pw_name != "agentportreview":
        raise SystemExit("Run only as the isolated agentportreview account")
    server = Server(("127.0.0.1", config["port"]), Portal(config))
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
