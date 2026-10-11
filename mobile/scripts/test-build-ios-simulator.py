#!/usr/bin/env python3
"""Exercise the build entry point without Xcode, credentials or live apps."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent
FAKE_TOOL = r'''#!/usr/bin/python3
import json, os, pathlib, plistlib, signal, socket, sys, time
name = pathlib.Path(sys.argv[0]).name
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
with (root / 'commands.jsonl').open('a') as out:
    out.write(json.dumps({'tool': name, 'args': sys.argv[1:], 'cwd': os.getcwd()}) + '\n')

def spawn_child():
    child = os.fork()
    if child:
        (root / 'child.pid').write_text(str(child))
        return
    # An orphan must not keep subprocess.run's captured pipes open. Even a
    # failing regression cleans its fixture child through this private file.
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2): os.dup2(null, fd)
    if os.environ.get('CHILD_IGNORE_TERM'):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while not (root / 'children.cleanup').exists(): time.sleep(.05)
    os._exit(0)

if name == 'npm':
    print('Xcode Simulator SDK 27.0 is not installed', file=sys.stderr)
    sys.exit(1)
if name == 'node':
    assert '--open' in sys.argv and '--debug' in sys.argv
    assert '--no-sign' not in sys.argv
    (root / 'helper.pid').write_text(str(os.getpid()))
    if os.environ.get('SPAWN_CHILD'): spawn_child()
    if os.environ.get('PREP_FAIL'): sys.exit(2)
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0)); listener.listen(); listener.settimeout(.1)
    pathlib.Path(os.environ['TMPDIR'], 'com.agentport.mobile-server-addr').write_text('127.0.0.1:' + str(listener.getsockname()[1]))
    def stop(*_):
        (root / 'helper.stopped').write_text('stopped')
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    while True:
        try:
            client, _ = listener.accept(); client.close()
        except socket.timeout: pass
if name == 'xcrun':
    assert sys.argv[1:4] == ['agvtool', 'new-version', '-all']
    (root / 'archive.version').write_text(sys.argv[4])
if name == 'xcodebuild':
    assert sys.argv[sys.argv.index('-destination') + 1] == 'generic/platform=iOS Simulator'
    assert 'CODE_SIGNING_ALLOWED=YES' in sys.argv
    assert '--no-sign' not in sys.argv and 'CODE_SIGNING_ALLOWED=NO' not in sys.argv
    assert not (root / 'helper.stopped').exists(), 'production options helper exited early'
    if os.environ.get('XCODE_CHILD'): spawn_child()
    if os.environ.get('XCODE_FAIL'): sys.exit(3)
    if os.environ.get('XCODE_WAIT'):
        (root / 'archive.waiting').touch()
        while not (root / 'children.cleanup').exists(): time.sleep(.05)
    archive = pathlib.Path(sys.argv[sys.argv.index('-archivePath') + 1])
    app = archive / 'Products/Applications/AgentPort.app'
    app.mkdir(parents=True)
    version_file = root / 'archive.version'
    version = version_file.read_text() if version_file.exists() else '0.1.0'
    config = json.loads((root / 'mobile/src-tauri/tauri.conf.json').read_text())
    info = {'CFBundleIdentifier': 'com.agentport.mobile', 'DTPlatformName': 'iphonesimulator',
            'MinimumOSVersion': '16.0', 'CFBundleVersion': version,
            'CFBundleShortVersionString': config['version']}
    if os.environ.get('STALE_VERSION'): info['CFBundleVersion'] = '0.1.0'
    if os.environ.get('STALE_SHORT_VERSION'): info['CFBundleShortVersionString'] = '0.1.0'
    with (app / 'Info.plist').open('wb') as out: plistlib.dump(info, out)
    (app / 'new-frontend').write_text('fresh embedded assets')
if name == 'codesign' and os.environ.get('SIGNATURE_FAIL'): sys.exit(4)
'''


def load_helper():
    spec = importlib.util.spec_from_file_location('simulator_builder', SCRIPTS / 'build-ios-simulator.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'verified.app'
        self.source.mkdir()
        (self.source / 'new-valid').write_text('verified replacement')
        self.destination = self.root / 'published.app'
        self.destination.mkdir()
        (self.destination / 'last-valid').write_text('verified previous build')
        self.helper = load_helper()

    def interrupt_rename(self, number, interrupt):
        rename = Path.rename
        calls = []

        def wrapped(path, target):
            result = rename(path, target)
            calls.append(path)
            if len(calls) == number: interrupt()
            return result

        return mock.patch.object(Path, 'rename', wrapped)

    def test_keyboard_interrupt_after_real_backup_move_restores_previous_bundle(self):
        def interrupt(): raise KeyboardInterrupt()
        with self.interrupt_rename(1, interrupt), self.assertRaises(KeyboardInterrupt):
            self.helper.publish_bundle(self.source, self.destination)
        self.assertTrue((self.destination / 'last-valid').exists())

    def test_keyboard_interrupt_after_commit_keeps_verified_replacement(self):
        def interrupt(): raise KeyboardInterrupt()
        with self.interrupt_rename(2, interrupt), self.assertRaises(KeyboardInterrupt):
            self.helper.publish_bundle(self.source, self.destination)
        self.assertTrue((self.destination / 'new-valid').exists())

    def test_failed_rollback_retains_verified_backup_for_recovery(self):
        rename = Path.rename
        def fail_after_backup(path, target):
            if path == self.destination:
                return rename(path, target)
            raise OSError('fixture filesystem unavailable')
        with mock.patch.object(Path, 'rename', fail_after_backup), self.assertRaises(OSError):
            self.helper.publish_bundle(self.source, self.destination)
        backups = list(self.root.glob('.simulator-publish-*/previous.app/last-valid'))
        self.assertEqual(len(backups), 1)

    def test_sigterm_after_backup_move_is_deferred_until_bundle_is_safe(self):
        def interrupt(*_): raise KeyboardInterrupt()
        previous = signal.signal(signal.SIGTERM, interrupt)
        self.addCleanup(signal.signal, signal.SIGTERM, previous)
        with self.interrupt_rename(1, lambda: os.kill(os.getpid(), signal.SIGTERM)), self.assertRaises(KeyboardInterrupt):
            self.helper.publish_bundle(self.source, self.destination)
        self.assertTrue(self.destination.exists())
        self.assertTrue((self.destination / 'last-valid').exists() or (self.destination / 'new-valid').exists())


class SimulatorBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.addCleanup(self.cleanup_children)
        self.mobile = self.root / 'mobile'
        scripts = self.mobile / 'scripts'
        scripts.mkdir(parents=True)
        shutil.copy2(SCRIPTS / 'build-ios-simulator.sh', scripts)
        helper = SCRIPTS / 'build-ios-simulator.py'
        if helper.exists(): shutil.copy2(helper, scripts)
        self.cli = self.mobile / 'node_modules/@tauri-apps/cli/tauri.js'
        self.cli.parent.mkdir(parents=True)
        self.cli.write_text('// fixture only')
        self.config = self.mobile / 'src-tauri/tauri.conf.json'
        self.config.parent.mkdir(parents=True)
        self.config.write_text(json.dumps({'identifier': 'com.agentport.mobile', 'productName': 'AgentPort', 'version': '0.1.0', 'bundle': {'iOS': {'minimumSystemVersion': '16.0'}}}))
        workspace = self.mobile / 'src-tauri/gen/apple/agentport-mobile.xcodeproj/project.xcworkspace'
        workspace.mkdir(parents=True)
        self.bundle = self.mobile / 'src-tauri/gen/apple/build/arm64-sim/AgentPort.app'
        self.bundle.mkdir(parents=True)
        (self.bundle / 'last-valid').write_text('preserve until new signed build is ready')
        tools = self.root / 'bin'
        tools.mkdir()
        for name in ['node', 'npm', 'xcodebuild', 'codesign', 'xcrun']:
            tool = tools / name
            tool.write_text(FAKE_TOOL); tool.chmod(0o755)
        self.env = {**os.environ, 'PATH': str(tools) + ':/usr/bin:/bin', 'FIXTURE_ROOT': str(self.root)}

    def child_running(self):
        pid_file = self.root / 'child.pid'
        if not pid_file.exists(): return False
        result = subprocess.run(['ps', '-o', 'stat=', '-p', pid_file.read_text()], capture_output=True, text=True)
        return bool(result.stdout.strip()) and not result.stdout.strip().startswith('Z')

    def cleanup_children(self):
        (self.root / 'children.cleanup').touch()
        deadline = time.monotonic() + 3
        while self.child_running() and time.monotonic() < deadline: time.sleep(.05)
        if self.child_running(): raise AssertionError('fixture child did not honor its private cleanup file')

    def change_versions(self, version='2.3.4', bundle_version=None):
        config = json.loads(self.config.read_text())
        config['version'] = version
        if bundle_version is not None: config['bundle']['iOS']['bundleVersion'] = bundle_version
        self.config.write_text(json.dumps(config))

    def run_build(self, *args, **flags):
        result = subprocess.run(['bash', str(self.mobile / 'scripts/build-ios-simulator.sh'), *args],
                                cwd=self.root, env={**self.env, **flags}, capture_output=True, text=True, timeout=20)
        self.commands = [json.loads(line) for line in (self.root / 'commands.jsonl').read_text().splitlines()] if (self.root / 'commands.jsonl').exists() else []
        return result

    def test_builds_signed_generic_simulator_with_live_production_options(self):
        result = self.run_build('--features', 'extra-fixture-feature')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.bundle / 'new-frontend').exists())
        self.assertFalse((self.bundle / 'last-valid').exists())
        self.assertTrue((self.root / 'helper.stopped').exists())
        cli = next(item['args'] for item in self.commands if item['tool'] == 'node')
        self.assertIn('--open', cli)
        self.assertIn('extra-fixture-feature', cli)
        self.assertEqual(cli[cli.index('--target') + 1], 'aarch64-sim')
        self.assertTrue(any(item['tool'] == 'codesign' and '--verify' in item['args'] for item in self.commands))
        self.assertFalse(any(item['tool'] == 'npm' for item in self.commands))

    def test_failed_archive_retains_last_bundle_and_stops_only_owned_helper(self):
        result = self.run_build(XCODE_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.bundle / 'last-valid').exists())
        self.assertTrue((self.root / 'helper.stopped').exists())

    def test_failed_signature_retains_last_bundle_and_stops_owned_helper(self):
        result = self.run_build(SIGNATURE_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.bundle / 'last-valid').exists())
        self.assertTrue((self.root / 'helper.stopped').exists())

    def test_no_sign_cannot_bypass_the_keychain_signing_gate(self):
        result = self.run_build('--no-sign')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.bundle / 'last-valid').exists())
        self.assertFalse(self.commands)

    def test_preparation_leader_failure_cleans_its_same_group_child(self):
        result = self.run_build(SPAWN_CHILD='1', PREP_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.bundle / 'last-valid').exists())
        self.assertTrue((self.root / 'child.pid').exists())
        self.assertFalse(self.child_running(), 'child survived its exited preparation leader')

    def test_archive_leader_failure_cleans_its_same_group_child(self):
        result = self.run_build(XCODE_CHILD='1', XCODE_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.root / 'child.pid').exists())
        self.assertFalse(self.child_running(), 'child survived its exited archive leader')

    def test_sigterm_resistant_child_is_killed_after_leader_exits(self):
        result = self.run_build(SPAWN_CHILD='1', CHILD_IGNORE_TERM='1')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / 'helper.stopped').exists())
        self.assertFalse(self.child_running(), 'waiting only for the leader leaked its TERM-resistant child')

    def test_cancelled_build_cleans_both_private_groups_without_stopping_unrelated_process(self):
        unrelated = subprocess.Popen(['/bin/sleep', '30'], start_new_session=True)
        self.addCleanup(lambda: unrelated.wait())
        self.addCleanup(lambda: unrelated.terminate() if unrelated.poll() is None else None)
        process = subprocess.Popen(['bash', str(self.mobile / 'scripts/build-ios-simulator.sh')],
                                   cwd=self.root, env={**self.env, 'XCODE_WAIT': '1', 'XCODE_CHILD': '1',
                                                       'CHILD_IGNORE_TERM': '1'},
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 5
            while not (self.root / 'archive.waiting').exists() and time.monotonic() < deadline:
                time.sleep(.05)
            self.assertTrue((self.root / 'archive.waiting').exists(), 'fixture archive did not start')
            process.terminate()
            self.assertEqual(process.wait(timeout=10), 143)
            self.assertTrue((self.root / 'helper.stopped').exists())
            self.assertFalse(self.child_running(), 'cancellation leaked a native-build descendant')
            self.assertTrue((self.bundle / 'last-valid').exists())
            self.assertIsNone(unrelated.poll(), 'cleanup signalled an unrelated private session')
        finally:
            (self.root / 'children.cleanup').touch()
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)

    def assert_archive_version(self, expected):
        import plistlib
        with (self.bundle / 'Info.plist').open('rb') as file: info = plistlib.load(file)
        self.assertEqual(info['CFBundleVersion'], expected)
        command = next(item for item in self.commands if item['tool'] == 'xcrun')
        self.assertEqual(command['args'], ['agvtool', 'new-version', '-all', expected])
        self.assertEqual(Path(command['cwd']).resolve(), (self.mobile / 'src-tauri/gen/apple').resolve())

    def test_configured_version_is_applied_before_archive(self):
        self.change_versions()
        result = self.run_build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_archive_version('2.3.4')

    def test_configured_bundle_version_and_build_number_are_applied(self):
        self.change_versions(bundle_version='7.8.9')
        result = self.run_build('--build-number', '42')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_archive_version('7.8.9.42')

    def test_equals_build_number_is_applied(self):
        result = self.run_build('--build-number=7')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_archive_version('0.1.0.7')

    def test_stale_bundle_version_cannot_be_published(self):
        self.change_versions()
        result = self.run_build(STALE_VERSION='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.bundle / 'last-valid').exists())

    def test_stale_short_version_cannot_be_published(self):
        self.change_versions()
        result = self.run_build(STALE_SHORT_VERSION='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.bundle / 'last-valid').exists())

    def test_config_override_is_rejected_rather_than_ignored_by_metadata_checks(self):
        result = self.run_build('--config', '{"version":"9.9.9"}')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.commands)


class OwnershipAndVersionTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()
        self.config = {'version': '0.1.0', 'bundle': {'iOS': {}}}

    def test_unexpected_supervisor_exit_is_detected_without_reaping_its_anchor(self):
        with tempfile.TemporaryDirectory() as work:
            owned = []
            process = self.helper.start_owned_process(['/bin/sleep', '30'], Path(work) / 'sleep.status',
                                                       Path(work), os.environ.copy(), owned)
            try:
                # Simulate a fatal supervisor/startup failure. The PID remains
                # unreaped/reserved; never poll Popen before group cleanup.
                os.killpg(process.anchor.pid, signal.SIGKILL)
                time.sleep(.1)
                with self.assertRaisesRegex(RuntimeError, 'supervisor exited'):
                    process.poll()
            finally:
                self.helper.stop_owned_processes(owned)

    def test_zombie_only_group_permission_error_is_not_confused_with_live_members(self):
        process = mock.Mock(anchor=mock.Mock(pid=123456))
        with mock.patch.object(self.helper.os, 'killpg', side_effect=PermissionError('fixture EPERM')):
            with mock.patch.object(self.helper.subprocess, 'run', return_value=mock.Mock(stdout='123456 Z\n42 S\n')):
                self.helper.signal_owned_group(process, signal.SIGKILL)
            with mock.patch.object(self.helper.subprocess, 'run', return_value=mock.Mock(stdout='123456 S\n')):
                with self.assertRaises(PermissionError):
                    self.helper.signal_owned_group(process, signal.SIGKILL)

    def test_cleanup_never_polls_anchor_or_signals_after_reaping(self):
        anchor = mock.Mock(pid=123456)
        anchor.poll.side_effect = AssertionError('reaped ownership anchor early')
        process = mock.Mock(anchor=anchor, stopped=False)
        events = []
        anchor.wait.side_effect = lambda: events.append('wait')
        with mock.patch.object(self.helper.os, 'killpg', side_effect=lambda pid, sig: events.append((pid, sig))), mock.patch.object(self.helper.time, 'sleep'):
            self.helper.stop_owned_processes([process])
            self.helper.stop_owned_processes([process])
        self.assertEqual(events, [(123456, signal.SIGTERM), (123456, signal.SIGKILL), 'wait'])
        anchor.poll.assert_not_called()

    def test_invalid_or_duplicate_build_numbers_are_rejected(self):
        for args in (['--build-number'], ['--build-number=-1'], ['--build-number=4294967296'],
                     ['--build-number=1.2'], ['--build-number=1', '--build-number=2']):
            with self.subTest(args=args), self.assertRaisesRegex(RuntimeError, 'build-number'):
                self.helper.archive_versions(self.config, args)

    def test_unsupported_version_and_config_forms_are_explicitly_rejected(self):
        for version in (None, {'path': 'package.json'}, '0.1.0-beta.1', '0.1.0+42', '1.2'):
            self.config['version'] = version
            with self.subTest(version=version), self.assertRaisesRegex(RuntimeError, 'config.version'):
                self.helper.archive_versions(self.config, [])
        self.config['version'] = '0.1.0'
        for args in (['--config={"version":"9.9.9"}'], ['-c', 'override.json'],
                     ['-coverride.json'], ['--version'], ['--', '--config', 'override.json']):
            with self.subTest(args=args), self.assertRaises(RuntimeError):
                self.helper.archive_versions(self.config, args)

    def test_null_bundle_version_falls_back_to_config_version(self):
        self.config['bundle']['iOS']['bundleVersion'] = None
        self.assertEqual(self.helper.archive_versions(self.config, ['--build-number=0007']), ('0.1.0.7', '0.1.0'))


if __name__ == '__main__':
    unittest.main()
