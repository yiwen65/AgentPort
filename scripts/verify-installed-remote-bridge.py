#!/usr/bin/env python3
"""Smoke-test the packaged AgentPort Remote Bridge without starting the GUI.

This is a functional installed-artifact check, not a sandbox for an untrusted
binary. Source-level no-listener coverage remains in the Remote Bridge crate.
The harness starts and, on failure, signals only the direct Bridge child that it
created. It never starts or signals an AgentPort GUI or Host.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import BinaryIO

MAX_FRAME_BYTES = 16 * 1024 * 1024


class SmokeFailure(RuntimeError):
    pass


def exact_process_pids(executable: Path) -> set[int]:
    """Return PIDs whose executable is exactly *executable* (never substring)."""
    target = executable.resolve()
    if sys.platform.startswith("linux"):
        result: set[int] = set()
        proc = Path("/proc")
        if not proc.is_dir():
            raise SmokeFailure("/proc is required for exact Linux process checks")
        for entry in proc.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                if (entry / "exe").resolve() == target:
                    result.add(int(entry.name))
            except (FileNotFoundError, PermissionError, OSError):
                continue
        return result

    completed = subprocess.run(
        ["ps", "-axo", "pid=,comm="],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=5,
    )
    result = set()
    for line in completed.stdout.splitlines():
        fields = line.strip().split(maxsplit=1)
        if len(fields) != 2:
            continue
        try:
            pid = int(fields[0])
            candidate = Path(fields[1]).resolve()
        except (ValueError, OSError):
            continue
        if candidate == target:
            result.add(pid)
    return result


def run_checked(command: list[str], timeout: float) -> None:
    try:
        subprocess.run(
            command,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except FileNotFoundError as error:
        raise SmokeFailure(f"required tool is unavailable: {command[0]}") from error
    except subprocess.TimeoutExpired as error:
        raise SmokeFailure(f"command timed out: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", "replace").strip()
        raise SmokeFailure(f"command failed: {' '.join(command)}: {detail}") from error


def write_frame(stream: BinaryIO, value: object) -> None:
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        raise SmokeFailure("outbound smoke frame exceeds protocol limit")
    stream.write(struct.pack(">I", len(payload)))
    stream.write(payload)
    stream.flush()


def _read_exact_with_deadline(fd: int, count: int, deadline: float) -> bytes:
    chunks: list[bytes] = []
    remaining = count
    while remaining:
        wait = deadline - time.monotonic()
        if wait <= 0:
            raise SmokeFailure("timed out reading Bridge protocol frame")
        ready, _, _ = select.select([fd], [], [], wait)
        if not ready:
            raise SmokeFailure("timed out reading Bridge protocol frame")
        chunk = os.read(fd, remaining)
        if not chunk:
            raise SmokeFailure("Bridge stdout closed before a complete protocol frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stream: BinaryIO, timeout: float) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    header = _read_exact_with_deadline(stream.fileno(), 4, deadline)
    (length,) = struct.unpack(">I", header)
    if length > MAX_FRAME_BYTES:
        raise SmokeFailure(f"Bridge advertised oversized frame: {length}")
    payload = _read_exact_with_deadline(stream.fileno(), length, deadline)
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SmokeFailure("Bridge returned invalid JSON") from error
    if not isinstance(value, dict):
        raise SmokeFailure("Bridge returned a non-object protocol frame")
    return value


def validate_hello(value: dict[str, object]) -> tuple[str, str]:
    if value.get("type") != "hello":
        raise SmokeFailure(f"expected hello response, got {value.get('type')!r}")
    protocol = value.get("protocol")
    if not isinstance(protocol, dict) or type(protocol.get("major")) is not int or protocol.get("major") != 1:
        raise SmokeFailure("Bridge did not negotiate protocol major 1")
    if type(protocol.get("minor")) is not int:
        raise SmokeFailure("Bridge hello omitted protocol minor")
    server = value.get("server")
    if not isinstance(server, dict):
        raise SmokeFailure("Bridge hello omitted server identity")
    platform = server.get("platform")
    version = server.get("agentportVersion")
    if not isinstance(platform, str) or not platform:
        raise SmokeFailure("Bridge hello omitted platform")
    if not isinstance(version, str) or not version:
        raise SmokeFailure("Bridge hello omitted AgentPort version")
    if not isinstance(value.get("capabilities"), list):
        raise SmokeFailure("Bridge hello omitted capabilities")
    if not isinstance(value.get("limits"), dict):
        raise SmokeFailure("Bridge hello omitted limits")
    return f"1.{protocol['minor']}", platform


def direct_socket_endpoints(pid: int, timeout: float) -> list[str]:
    """Inspect only the Bridge process; the source test proves no listener path."""
    if sys.platform.startswith("linux"):
        fd_dir = Path(f"/proc/{pid}/fd")
        if not fd_dir.is_dir():
            if not Path(f"/proc/{pid}").exists():
                raise SmokeFailure("Bridge exited before socket inspection")
            raise SmokeFailure("cannot inspect Bridge file descriptors")
        endpoints = []
        for fd in fd_dir.iterdir():
            try:
                target = os.readlink(fd)
            except (FileNotFoundError, PermissionError, OSError):
                continue
            if target.startswith("socket:["):
                endpoints.append(f"{fd.name}:{target}")
        return sorted(endpoints)

    if shutil.which("lsof") is None:
        raise SmokeFailure("lsof is required for macOS socket inspection")
    endpoints: list[str] = []
    # lsof selection options are ORed unless -a is used. Query Internet and
    # Unix sockets separately because `-a ... -i -U` would require a file to
    # satisfy two disjoint selectors and would always return an empty set.
    for selector in ("-i", "-U"):
        try:
            completed = subprocess.run(
                ["lsof", "-nP", "-a", "-p", str(pid), selector],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as error:
            raise SmokeFailure("socket inspection timed out") from error
        if completed.returncode not in (0, 1):
            raise SmokeFailure(f"lsof failed: {completed.stderr.strip()}")
        lines = completed.stdout.splitlines()
        endpoints.extend(lines[1:] if len(lines) > 1 else [])
    return endpoints


def wait_for_stdout_eof(stream: BinaryIO, timeout: float) -> bytes:
    """Read bounded trailing stdout and require EOF before the deadline."""
    deadline = time.monotonic() + timeout
    trailing = bytearray()
    fd = stream.fileno()
    while True:
        wait = deadline - time.monotonic()
        if wait <= 0:
            raise SmokeFailure("Bridge stdout did not close before the deadline")
        ready, _, _ = select.select([fd], [], [], wait)
        if not ready:
            raise SmokeFailure("Bridge stdout did not close before the deadline")
        chunk = os.read(fd, 4096)
        if not chunk:
            return bytes(trailing)
        trailing.extend(chunk)
        if len(trailing) > MAX_FRAME_BYTES:
            raise SmokeFailure("unexpected trailing Bridge stdout exceeds protocol limit")


def stop_direct_child(process: subprocess.Popen[bytes], timeout: float) -> None:
    """Best-effort cleanup of the direct child only; never signal a process tree."""
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=timeout)
        return
    except subprocess.TimeoutExpired:
        pass
    if process.poll() is None:
        process.kill()
        process.wait(timeout=timeout)


def run_smoke(
    bridge: Path,
    gui: Path,
    host: Path | None,
    codesign_target: Path | None,
    timeout: float,
) -> tuple[str, str, set[int]]:
    bridge = bridge.resolve()
    gui = gui.resolve()
    if not bridge.is_file() or not os.access(bridge, os.X_OK):
        raise SmokeFailure(f"Bridge is not an executable file: {bridge}")
    if not gui.is_file() or not os.access(gui, os.X_OK):
        raise SmokeFailure(f"GUI is not an executable file: {gui}")
    if host is None:
        raise SmokeFailure("an exact packaged Host executable is required")
    host = host.resolve()
    if not host.is_file() or not os.access(host, os.X_OK):
        raise SmokeFailure(f"Host is not an executable file: {host}")

    gui_pids = exact_process_pids(gui)
    if gui_pids:
        rendered = ", ".join(str(pid) for pid in sorted(gui_pids))
        raise SmokeFailure(
            f"refusing to start Bridge while the exact GUI executable is running "
            f"({gui}; PIDs: {rendered}). Stop that GUI outside this harness and retry."
        )

    if codesign_target is not None:
        if sys.platform != "darwin":
            raise SmokeFailure("--codesign-target is supported only on macOS")
        run_checked(
            ["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(codesign_target.resolve())],
            timeout,
        )

    host_pids_before = exact_process_pids(host)
    with tempfile.TemporaryDirectory(prefix="agentport-installed-bridge-") as temp:
        root = Path(temp)
        data_dir = root / "data"
        socket_dir = root / "sockets"
        data_dir.mkdir(mode=0o700)
        socket_dir.mkdir(mode=0o700)
        env = os.environ.copy()
        env["AGENTPORT_DATA_DIR"] = str(data_dir)
        env["AGENTPORT_SOCKET_DIR"] = str(socket_dir)
        env["HOME"] = str(root / "home")
        Path(env["HOME"]).mkdir(mode=0o700)

        with (root / "stderr.log").open("w+b") as diagnostics:
            process = subprocess.Popen(
                [str(bridge), "serve", "--stdio"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=diagnostics,
                env=env,
            )
            try:
                assert process.stdin is not None and process.stdout is not None
                write_frame(
                    process.stdin,
                    {
                        "type": "hello",
                        "protocol": {"major": 1, "minor": 0},
                        "client": {"name": "installed-smoke", "version": "1"},
                        "requestedCapabilities": [],
                    },
                )
                protocol, platform = validate_hello(read_frame(process.stdout, timeout))
                if process.poll() is not None:
                    raise SmokeFailure("Bridge exited immediately after hello")
                sockets = direct_socket_endpoints(process.pid, timeout)
                if sockets:
                    raise SmokeFailure(f"Bridge owns socket endpoints: {sockets}")
                if exact_process_pids(host) != host_pids_before:
                    raise SmokeFailure("installed Host process set changed while serving hello")

                process.stdin.close()
                try:
                    status = process.wait(timeout=timeout)
                except subprocess.TimeoutExpired as error:
                    raise SmokeFailure("Bridge did not exit after protocol stdin EOF") from error
                if status != 0:
                    raise SmokeFailure(f"Bridge exited with status {status} after stdin EOF")
                trailing = wait_for_stdout_eof(process.stdout, timeout)
                if trailing:
                    raise SmokeFailure("Bridge wrote unexpected stdout bytes after hello")
            finally:
                stop_direct_child(process, timeout)

    if exact_process_pids(gui):
        raise SmokeFailure("GUI process appeared during Bridge smoke")
    if exact_process_pids(host) != host_pids_before:
        raise SmokeFailure("installed Host process set changed during Bridge smoke")
    return protocol, platform, host_pids_before


class HarnessSelfTests(unittest.TestCase):
    def test_frame_round_trip(self) -> None:
        read_fd, write_fd = os.pipe()
        try:
            with os.fdopen(write_fd, "wb", closefd=False) as writer:
                write_frame(writer, {"type": "hello", "protocol": {"major": 1}})
            with os.fdopen(read_fd, "rb", closefd=False) as reader:
                value = read_frame(reader, 1)
            self.assertEqual(value["type"], "hello")
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_oversized_advertisement_is_rejected_before_payload(self) -> None:
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, struct.pack(">I", MAX_FRAME_BYTES + 1))
            with os.fdopen(read_fd, "rb", closefd=False) as reader:
                with self.assertRaisesRegex(SmokeFailure, "oversized"):
                    read_frame(reader, 1)
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_boolean_protocol_versions_are_rejected(self) -> None:
        malformed = {
            "type": "hello",
            "protocol": {"major": True, "minor": False},
            "server": {"platform": "test", "agentportVersion": "1"},
            "capabilities": [],
            "limits": {},
        }
        with self.assertRaisesRegex(SmokeFailure, "protocol major"):
            validate_hello(malformed)

    def test_exact_process_match_does_not_match_host_prefix(self) -> None:
        self.assertNotEqual(
            Path("/tmp/App/agentport").resolve(),
            Path("/tmp/App/agentport-host").resolve(),
        )

    def test_stdout_eof_wait_is_deadline_bounded(self) -> None:
        read_fd, write_fd = os.pipe()
        try:
            with os.fdopen(read_fd, "rb", closefd=False) as reader:
                start = time.monotonic()
                with self.assertRaisesRegex(SmokeFailure, "deadline"):
                    wait_for_stdout_eof(reader, 0.05)
                self.assertLess(time.monotonic() - start, 0.5)
        finally:
            os.close(read_fd)
            os.close(write_fd)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge", type=Path, help="packaged Remote Bridge executable")
    parser.add_argument("--gui", type=Path, help="exact packaged GUI executable")
    parser.add_argument("--host", type=Path, help="exact packaged Host executable")
    parser.add_argument("--codesign-target", type=Path, help="optional macOS bundle/binary to verify")
    parser.add_argument("--timeout", type=float, default=5.0, help="per-operation timeout in seconds")
    parser.add_argument("--self-test", action="store_true", help="run harmless harness tests")
    args = parser.parse_args()
    if not args.self_test and (args.bridge is None or args.gui is None or args.host is None):
        parser.error("--bridge, --gui, and --host are required unless --self-test is used")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    return args


def main() -> int:
    args = parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(HarnessSelfTests)
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    try:
        protocol, platform, hosts = run_smoke(
            args.bridge, args.gui, args.host, args.codesign_target, args.timeout
        )
    except (SmokeFailure, OSError, subprocess.SubprocessError) as error:
        print(f"INSTALLED-REMOTE-BRIDGE: FAIL: {error}", file=sys.stderr)
        return 1
    rendered_hosts = ",".join(str(pid) for pid in sorted(hosts))
    print(
        f"INSTALLED-REMOTE-BRIDGE: PASS protocol={protocol} platform={platform} "
        f"installedHostPids=[{rendered_hosts}] codesign={args.codesign_target is not None}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
