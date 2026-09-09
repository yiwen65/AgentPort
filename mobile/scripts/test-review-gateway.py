import base64
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading
import unittest
import urllib.parse

spec = importlib.util.spec_from_file_location('gateway', Path(__file__).with_name('review_gateway.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rv-', dir='/tmp')
        self.addCleanup(self.temp.cleanup)
        self.now = 1000
        self.config = dict(origin='https://review.example.test', relay_url='wss://review.example.test/v1/relay',
                           username='review', password_sha256=gateway.hashlib.sha256(b'fixture-password').hexdigest(),
                           expires_at=2000, max_devices=3, max_invitations=4,
                           state_path=self.temp.name + '/state.json', socket_directory=self.temp.name, port=0)
        self.calls = []
        self.status = dict(phase='connected', devices=[], pairing=None)
        self.invite = dict(id='fixture-id', expiresAt=1120, secret='fixture-secret',
                           peer=dict(relayUrl=self.config['relay_url']))
        self.portal = gateway.Portal(self.config, self.call, lambda: self.now)
        self.server = gateway.Server(('127.0.0.1', 0), self.portal)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def call(self, request):
        self.calls.append(request)
        if request['kind'] == 'status':
            return dict(status=self.status)
        self.status['pairing'] = dict(invitationId='fixture-id', expiresAt=1120, phase='waiting')
        return dict(invitation=self.invite)

    def request(self, method='GET', path='/', auth=True, headers=None, data=None):
        h = dict(Host=self.portal.host)
        if auth:
            h['Authorization'] = 'Basic ' + base64.b64encode(b'review:fixture-password').decode()
        if method == 'POST':
            h['Origin'] = self.config['origin']
            h['Content-Type'] = 'application/x-www-form-urlencoded'
            if data is None:
                data = urllib.parse.urlencode(dict(csrf=self.portal.csrf))
        h.update(headers or {})
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            c.request(method, path, body=data, headers=h)
            r = c.getresponse()
            return r.status, dict(r.getheaders()), r.read().decode()
        finally:
            c.close()

    def test_unauthenticated_never_contacts_connector(self):
        status, headers, body = self.request(auth=False)
        self.assertEqual(status, 401)
        self.assertIn('WWW-Authenticate', headers)
        self.assertNotIn(self.portal.csrf, body)
        self.assertEqual(self.calls, [])

    def test_page_does_not_generate_code(self):
        status, headers, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        # no-referrer makes a browser navigation POST's Origin opaque (null),
        # conflicting with this portal's strict same-origin form validation.
        self.assertEqual(headers['Referrer-Policy'], 'same-origin')
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        self.assertNotIn('fixture-secret', body)
        self.assertEqual(self.calls, [])

    def test_valid_post_and_repeated_post_reuse_one_code(self):
        for _ in range(2):
            status, _, body = self.request('POST', '/invite')
            self.assertEqual(status, 200)
            self.assertIn('fixture-secret', body)
        self.assertEqual(self.calls.count({'kind': 'invite_automatic'}), 1)
        self.assertEqual(json.loads(Path(self.config['state_path']).read_text()), {'issued': 1})
        self.assertEqual(os.stat(self.config['state_path']).st_mode & 0o777, 0o600)

    def test_loopback_to_public_address_preserves_identity_secret_and_expiry(self):
        self.config['connector_relay_url'] = 'ws://127.0.0.1:43868/v1/relay'
        self.invite['peer']['relayUrl'] = self.config['connector_relay_url']
        self.invite['peer']['hostId'] = 'pinned-host'
        self.invite['peer']['publicKey'] = 'pinned-key'
        original = json.loads(json.dumps(self.invite))
        result = self.portal.issue()
        self.assertEqual(self.invite, original)
        self.assertEqual(result['peer']['relayUrl'], self.config['relay_url'])
        result['peer']['relayUrl'] = original['peer']['relayUrl']
        self.assertEqual(result, original)

    def test_html_escapes_invitation(self):
        self.invite['peer']['name'] = '<script>alert(1)</script>'
        _, _, body = self.request('POST', '/invite')
        self.assertNotIn('<script>', body)
        self.assertIn('&lt;script&gt;', body)

    def test_auth_origin_csrf_and_host_rejected(self):
        cases = [({'Host': 'evil.test'}, None, 400),
                 ({'Origin': 'https://evil.test'}, None, 403),
                 ({'Origin': 'null'}, None, 403),
                 ({}, 'csrf=wrong', 403),
                 ({'Authorization': 'Basic !!!'}, None, 401),
                 ({'Authorization': 'Basic ' + base64.b64encode(b'review:bad').decode()}, None, 401)]
        for headers, data, code in cases:
            with self.subTest(headers=headers):
                self.assertEqual(self.request('POST', '/invite', headers=headers, data=data)[0], code)
        self.assertEqual(self.calls, [])

    def test_no_credential_in_url_and_no_arbitrary_ipc(self):
        for path in ['/invite?password=fixture-password', '/configure', '/revoke', '/../../etc/passwd']:
            self.assertEqual(self.request('POST', path)[0], 404)
        self.assertEqual(self.calls, [])

    def test_body_limit_and_transfer_encoding(self):
        self.assertEqual(self.request('POST', '/invite', data='x' * 257)[0], 400)
        self.assertEqual(self.request('POST', '/invite', headers={'Transfer-Encoding': 'chunked'}, data='0\r\n\r\n')[0], 400)
        self.assertEqual(self.calls, [])

    def test_expired_login_is_closed(self):
        self.now = 2000
        self.assertEqual(self.request()[0], 410)
        self.assertEqual(self.request('POST', '/invite')[0], 410)
        self.assertEqual(self.calls, [])

    def test_failed_login_rate_limit_is_bounded_and_recovers(self):
        for _ in range(40):
            self.assertEqual(self.portal.authenticate(''), 401)
        self.assertEqual(self.portal.authenticate(''), 429)
        self.assertEqual(len(self.portal.failures), 40)
        self.assertEqual(self.request()[0], 200)  # Anonymous traffic cannot lock out valid credentials.
        self.now += 61
        self.assertEqual(self.portal.authenticate(''), 401)

    def test_offline_and_device_limit_never_issue(self):
        self.status['phase'] = 'reconnecting'
        self.assertEqual(self.request('POST', '/invite')[0], 503)
        self.status['phase'] = 'connected'
        self.status['devices'] = [1, 2, 3]
        self.assertEqual(self.request('POST', '/invite')[0], 503)
        self.assertNotIn({'kind': 'invite_automatic'}, self.calls)

    def test_unknown_pending_write_is_not_replayed(self):
        self.status['pairing'] = dict(invitationId='unknown', expiresAt=1120, phase='waiting')
        self.assertEqual(self.request('POST', '/invite')[0], 503)
        self.assertNotIn({'kind': 'invite_automatic'}, self.calls)

    def test_persisted_attempt_budget_survives_restart(self):
        Path(self.config['state_path']).write_text(json.dumps({'issued': 4}))
        os.chmod(self.config['state_path'], 0o600)
        p = gateway.Portal(self.config, self.call, lambda: self.now)
        with self.assertRaises(gateway.Unavailable):
            p.issue()
        self.assertNotIn({'kind': 'invite_automatic'}, self.calls)

    def test_storage_failure_does_not_mutate_connector(self):
        Path(self.config['state_path'] + '.new').write_text('occupied')
        self.assertEqual(self.request('POST', '/invite')[0], 503)
        self.assertNotIn({'kind': 'invite_automatic'}, self.calls)

    def test_failed_mutation_consumes_budget_without_automatic_retry(self):
        def call(request):
            if request['kind'] == 'invite_automatic':
                raise TimeoutError()
            return dict(status=self.status)
        self.portal.call = call
        self.assertEqual(self.request('POST', '/invite')[0], 503)
        self.assertEqual(json.loads(Path(self.config['state_path']).read_text())['issued'], 1)
        self.assertEqual(self.request('POST', '/invite')[0], 503)
        self.assertEqual(json.loads(Path(self.config['state_path']).read_text())['issued'], 1)

    def test_long_invitation_expiry_never_renders_secret(self):
        self.invite['expiresAt'] = self.now + 3600
        status, _, body = self.request('POST', '/invite')
        self.assertEqual(status, 503)
        self.assertNotIn('fixture-secret', body)

    def test_wrong_relay_never_renders_secret(self):
        self.invite['peer']['relayUrl'] = 'wss://private.example.test/v1/relay'
        status, _, body = self.request('POST', '/invite')
        self.assertEqual(status, 503)
        self.assertNotIn('fixture-secret', body)

    def test_relay_configuration_cannot_point_at_another_or_insecure_origin(self):
        for change in [dict(relay_url='ws://review.example.test/v1/relay'),
                       dict(relay_url='wss://private.example.test/v1/relay'),
                       dict(connector_relay_url='ws://192.168.1.1/v1/relay'),
                       dict(connector_relay_url='ws://user@127.0.0.1/v1/relay'),
                       dict(origin='https://:password@review.example.test')]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                gateway.Portal(dict(self.config, **change), self.call, lambda: self.now)

    def test_loopback_binding_required(self):
        with self.assertRaises(ValueError):
            gateway.Server(('0.0.0.0', 0), self.portal)

    def test_config_paths_must_be_private_and_not_symlinks(self):
        path = Path(self.temp.name) / 'unsafe'
        path.write_text('{}')
        os.chmod(path, 0o644)
        with self.assertRaises(ValueError):
            gateway.private_path(path)
        link = Path(self.temp.name) / 'link'
        link.symlink_to(path)
        with self.assertRaises(ValueError):
            gateway.private_path(link)

    def test_real_same_user_unix_ipc_framing_and_peer(self):
        path = self.temp.name + '/control.sock'
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(path)
        os.chmod(path, 0o600)
        listener.listen(1)
        self.addCleanup(listener.close)
        requests = []
        def respond():
            connection, _ = listener.accept()
            with connection:
                size = struct.unpack('!I', connection.recv(4))[0]
                requests.append(json.loads(connection.recv(size)))
                response = json.dumps({'kind': 'status', 'status': self.status}).encode()
                connection.sendall(struct.pack('!I', len(response)) + response)
        worker = threading.Thread(target=respond)
        worker.start()
        self.assertEqual(gateway.ipc(self.temp.name, {'kind': 'status'})['status']['phase'], 'connected')
        worker.join(3)
        self.assertEqual(requests, [{'kind': 'status'}])


class RevocationTests(unittest.TestCase):
    def test_closes_enrollment_before_taking_the_device_snapshot(self):
        from review_access_control import revoke_devices
        devices = [{'publicKey': 'first'}]
        pairing = {'phase': 'waiting', 'invitationId': 'invite'}
        requests = []
        def call(request):
            requests.append(request['kind'])
            if request['kind'] == 'close_invitation':
                # A phone finished approval immediately before the close.
                devices.append({'publicKey': 'raced'})
                pairing['phase'] = 'expired'
            if request['kind'] == 'revoke':
                devices[:] = [d for d in devices if d['publicKey'] != request['public_key']]
            return {'status': {'devices': list(devices), 'pairing': dict(pairing), 'activeChannels': len(devices)}}
        self.assertEqual(revoke_devices(call), {'revoked': 2, 'remainingDevices': 0, 'activeChannels': 0})
        self.assertEqual(requests, ['status', 'close_invitation', 'status', 'revoke', 'revoke', 'status'])

    def test_does_not_claim_success_when_revocation_did_not_persist(self):
        from review_access_control import revoke_devices
        def call(request):
            return {'status': {'devices': [{'publicKey': 'still-authorized'}], 'pairing': None, 'activeChannels': 1}}
        with self.assertRaises(RuntimeError):
            revoke_devices(call)


if __name__ == '__main__':
    unittest.main()
