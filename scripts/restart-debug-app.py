#!/usr/bin/env python3
"""Rebuild/reopen this checkout's debug GUI without signalling its helpers."""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "target/debug/bundle/macos/AgentPort.app"
GUI = APP / "Contents/MacOS/agentport"


def gui_pids(executable, process_table):
    """ps comm is the executable path, not argv; never prefix/regex match it."""
    found = set()
    for line in process_table.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[0].isdigit():
            pid = int(fields[0])
            if pid > 1 and fields[1] == str(executable):
                found.add(pid)
    return sorted(found)


def process_table():
    return subprocess.check_output(["/bin/ps", "-axo", "pid=,comm="], text=True)


def stop_gui(executable, read_processes=process_table, send_signal=os.kill,
             sleep=time.sleep, monotonic=time.monotonic):
    selected = gui_pids(executable, read_processes())
    for pid in selected:
        # Recheck after discovery: the PID may have exited or been reused.
        if pid not in gui_pids(executable, read_processes()):
            continue
        print(f"Stopping debug GUI PID {pid}: {executable}", flush=True)
        try:
            send_signal(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = monotonic() + 10
    while set(selected).intersection(gui_pids(executable, read_processes())):
        if monotonic() >= deadline:
            raise RuntimeError("Old debug GUI did not exit; refusing to force-kill or open another instance")
        sleep(0.1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true", help="reopen the already-built, signed debug bundle")
    parser.add_argument("--dry-run", action="store_true", help="print exact GUI targets only; do not build, signal, or open")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This launcher is for the macOS debug bundle")
    if args.dry_run:
        print(f"Debug GUI: {GUI}")
        print(f"Exact GUI PIDs: {gui_pids(GUI, process_table())}")
        return
    if not args.skip_build:
        subprocess.run(["bash", str(ROOT / "scripts/rebuild-debug-app.sh")], cwd=ROOT, check=True)
    if not GUI.is_file():
        raise RuntimeError(f"Debug GUI not built: {GUI}")
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(APP)], check=True)
    stop_gui(GUI)
    subprocess.run(["/usr/bin/open", "-n", str(APP)], check=True)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        pids = gui_pids(GUI, process_table())
        if pids:
            print(f"Opened debug GUI PIDs {pids}: {GUI}")
            return
        time.sleep(0.2)
    raise RuntimeError("Debug GUI executable not observed after open; inspect startup logs")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Debug restart failed: {error}", file=sys.stderr)
        sys.exit(1)
