#!/usr/bin/env python3
"""Keep Tauri's production options alive while Xcode builds a signed simulator app.

CLI 2.11.4/cargo-mobile2 0.22.4 mistakes a runtime older than the SDK for a
missing SDK. Generic simulator archives need the SDK, not a same-version runtime.
"""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import plistlib
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent


@contextmanager
def cancellation_blocked():
    """Defer catchable cancellation only across ownership/rename transactions."""
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def supervise(status_file, command, monitor_fd):
    # Only the anchor keeps this pipe open; EOF detects fatal supervisor failure
    # without polling/reaping its PID. Do not pass the pipe to the command.
    os.set_inheritable(monitor_fd, False)
    # A live, unreaped session leader anchors the PGID even after the command
    # exits. Handlers (not SIG_IGN) reset to defaults when the command execs.
    signal.signal(signal.SIGTERM, lambda *_: None)
    signal.signal(signal.SIGINT, lambda *_: None)
    # Creation is masked in the parent. Unmask only after our handlers exist;
    # the command and all its descendants must receive normal termination.
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT, signal.SIGTERM})
    try:
        result = subprocess.Popen(command).wait()
    except OSError as error:
        print(str(error), file=sys.stderr)
        result = 1
    temporary = status_file.with_suffix('.pending')
    temporary.write_text(str(result))
    temporary.replace(status_file)
    while True:
        signal.pause()


class OwnedProcess:
    def __init__(self, command, status_file, cwd, env):
        self.status_file = status_file
        self.stopped = False
        self.monitor_fd, writer = os.pipe()
        try:
            self.anchor = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), '--_supervise', str(status_file), str(writer), *command],
                cwd=cwd, env=env, start_new_session=True, pass_fds=(writer,),
            )
        except BaseException:
            os.close(self.monitor_fd)
            raise
        finally:
            os.close(writer)

    def poll(self):
        # Never poll/wait the anchor here: reaping it would allow PID/PGID reuse.
        try:
            return int(self.status_file.read_text())
        except FileNotFoundError:
            if select.select([self.monitor_fd], [], [], 0)[0]:
                raise RuntimeError("Build supervisor exited before recording command status")
            return None

    def close(self):
        os.close(self.monitor_fd)

    def wait(self):
        while True:
            result = self.poll()
            if result is not None:
                return result
            time.sleep(.05)


def start_owned_process(command, status_file, cwd, env, owned):
    # Record ownership before unmasking a pending cancellation.
    with cancellation_blocked():
        process = OwnedProcess(command, status_file, cwd, env)
        owned.append(process)
    return process


def signal_owned_group(process, sig):
    try:
        os.killpg(process.anchor.pid, sig)
    except ProcessLookupError:
        pass
    except PermissionError:
        # macOS returns EPERM, not ESRCH, for an unreaped zombie-only group.
        # Keep the anchor reserved while proving there are no live members;
        # never suppress a permission failure for a group with a live process.
        snapshot = subprocess.run(['ps', '-axo', 'pgid=,stat='], check=True, capture_output=True, text=True)
        for line in snapshot.stdout.splitlines():
            pgid, state = line.split()
            if int(pgid) == process.anchor.pid and not state.startswith('Z'):
                raise


def stop_owned_processes(owned):
    # Every anchor was created with start_new_session=True and has never been
    # reaped. Signal only those groups, including descendants of exited commands.
    # Keep anchors alive through the grace period, then kill groups BEFORE wait.
    with cancellation_blocked():
        pending = [process for process in owned if not process.stopped]
        for process in pending:
            signal_owned_group(process, signal.SIGTERM)
        if pending:
            time.sleep(5)
        for process in pending:
            signal_owned_group(process, signal.SIGKILL)
            process.anchor.wait()
            process.stopped = True
            process.close()


def wait_for_options(process, address_file, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Tauri production preparation exited before its options server was ready")
        try:
            host, port = address_file.read_text().strip().split(":")
            if host != "127.0.0.1":
                raise RuntimeError("Unexpected non-loopback Tauri options server")
            with socket.create_connection((host, int(port)), timeout=1):
                return
        except (OSError, ValueError):
            time.sleep(0.1)
    raise RuntimeError("Timed out waiting for Tauri production build options")


def publish_bundle(source, destination):
    """Stage on the same filesystem; keep the last valid bundle until verified."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".simulator-publish-", dir=destination.parent))
    staged = staging / destination.name
    backup = staging / "previous.app"
    copied = False
    try:
        shutil.copytree(source, staged, symlinks=True)
        copied = True
        with cancellation_blocked():
            try:
                if destination.exists():
                    destination.rename(backup)
                staged.rename(destination)
            except BaseException:
                # An interrupted rename may already have succeeded. Preserve a
                # committed verified replacement; restore only a missing target.
                if not destination.exists() and backup.exists():
                    backup.rename(destination)
                raise
    finally:
        if destination.exists() or not copied:
            shutil.rmtree(staging)
        else:
            # If filesystem rollback itself failed, do not delete the only
            # verified copy. Report its location for recovery.
            print("Retained verified simulator bundle in: " + str(staging), file=sys.stderr)


def archive_versions(config, extra_args):
    # --open returns before Tauri's archive/build-number branch. Apply the same
    # numeric bundleVersion (falling back to version) + optional u32 build number.
    # Explicitly reject formats/overrides we cannot match, rather than validating
    # an archive against stale, unmerged configuration.
    build_number = None
    index = 0
    while index < len(extra_args):
        arg = extra_args[index]
        if arg == '--' or arg.startswith('--config') or arg.startswith('-c'):
            raise RuntimeError("Config overrides/runner arguments are not supported by the simulator archive helper")
        if arg == '--version' or arg == '-V':
            raise RuntimeError("Version query arguments are not supported by the simulator archive helper")
        if arg == '--build-number' or arg.startswith('--build-number='):
            if build_number is not None:
                raise RuntimeError("--build-number may only be supplied once")
            if arg == '--build-number':
                index += 1
                if index == len(extra_args):
                    raise RuntimeError("--build-number requires an unsigned 32-bit integer")
                number = extra_args[index]
            else:
                number = arg.split('=', 1)[1]
            if not re.fullmatch(r'[0-9]+', number) or int(number) > 4294967295:
                raise RuntimeError("--build-number requires an unsigned 32-bit integer")
            build_number = str(int(number))
        index += 1
    for extension in ('json', 'json5', 'toml'):
        if (ROOT / ('src-tauri/tauri.ios.conf.' + extension)).exists():
            raise RuntimeError("Platform config overrides are not supported by the simulator archive helper")
    version = config.get('version')
    bundle_version = config['bundle']['iOS'].get('bundleVersion')
    if bundle_version is None:
        bundle_version = version
    if not isinstance(version, str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){2}', version):
        raise RuntimeError("Simulator config.version must be a numeric major.minor.patch string")
    if not isinstance(bundle_version, str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+)*', bundle_version):
        raise RuntimeError("Simulator bundle.iOS.bundleVersion must contain only dot-separated integers")
    if build_number is not None:
        bundle_version += '.' + build_number
    return bundle_version, version


def build(extra_args):
    if any(arg == "--no-sign" or arg.startswith("--no-sign=") for arg in extra_args):
        raise RuntimeError("Simulator signing is required for Keychain; --no-sign is not supported")
    config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
    bundle_version, short_version = archive_versions(config, extra_args)
    project = ROOT / "src-tauri/gen/apple/agentport-mobile.xcodeproj"
    workspace = ROOT / "src-tauri/gen/apple/agentport-mobile.xcworkspace"
    if not workspace.exists():
        workspace = project / "project.xcworkspace"
    if not workspace.is_dir():
        raise RuntimeError("Generated iOS workspace is missing; run tauri ios init first")
    cli = ROOT / "node_modules/@tauri-apps/cli/tauri.js"
    if not cli.is_file():
        raise RuntimeError("Tauri CLI is missing; run npm ci in mobile first")
    owned = []
    # xcode-script must use this invocation's live options, not another checkout's
    # dev/build server. The temporary namespace is inherited by both processes.
    with tempfile.TemporaryDirectory(prefix="agentport-ios-simulator-") as work:
        env = dict(os.environ, TMPDIR=work + os.sep)
        archive = Path(work) / "AgentPort-simulator.xcarchive"

        def start(command, name, cwd=ROOT):
            return start_owned_process(command, Path(work) / (name + '.status'), cwd, env, owned)

        def run(command, name, cwd=ROOT):
            result = start(command, name, cwd).wait()
            if result:
                raise subprocess.CalledProcessError(result, command)

        try:
            helper = start(
                ["node", str(cli), "ios", "build", "--debug", "--target", "aarch64-sim", "--open", "--ci", *extra_args],
                'tauri',
            )
            wait_for_options(helper, Path(work) / (config["identifier"] + "-server-addr"))
            run(['xcrun', 'agvtool', 'new-version', '-all', bundle_version], 'version', cwd=project.parent)
            run(
                ["xcodebuild", "-workspace", str(workspace), "-scheme", "agentport-mobile_iOS",
                 "-configuration", "debug", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator",
                 "-archivePath", str(archive), "ARCHS=arm64", "CODE_SIGNING_ALLOWED=YES", "archive"],
                'archive',
            )
            app = archive / "Products/Applications" / (config["productName"] + ".app")
            with (app / "Info.plist").open("rb") as file:
                info = plistlib.load(file)
            if info.get("CFBundleIdentifier") != config["identifier"] or info.get("DTPlatformName") != "iphonesimulator":
                raise RuntimeError("Archive is not the configured simulator App")
            minimum = config["bundle"]["iOS"]["minimumSystemVersion"]
            if info.get("MinimumOSVersion") != minimum:
                raise RuntimeError("Archive changed the configured minimum iOS version")
            if info.get('CFBundleVersion') != bundle_version or info.get('CFBundleShortVersionString') != short_version:
                raise RuntimeError("Archive does not match the configured App/build version")
            run(["codesign", "--verify", "--deep", "--strict", str(app)], 'signature')
            destination = ROOT / "src-tauri/gen/apple/build/arm64-sim" / app.name
            publish_bundle(app, destination)
            print("Built signed simulator App: " + str(destination), flush=True)
        finally:
            stop_owned_processes(owned)


def main():
    # Make cancellation unwind the owned sessions and temporary RPC namespace.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        build(sys.argv[1:])
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print("Simulator build failed: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 3 and sys.argv[1] == '--_supervise':
        supervise(Path(sys.argv[2]), sys.argv[4:], int(sys.argv[3]))
    else:
        sys.exit(main())
