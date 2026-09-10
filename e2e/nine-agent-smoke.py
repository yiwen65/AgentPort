#!/usr/bin/env python3
"""Real CLI/Host/PTY startup smoke without login, prompts, or user configuration.

Example: python3 e2e/nine-agent-smoke.py --agent omp=/absolute/path/to/omp
Pass only trusted installed executables. Each run gets a fresh HOME and app data
root, never calls session input, and stops only the Sessions it created through
the normal AgentPort API. This verifies startup, not authenticated model turns.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path, default=Path("target/debug/agentport-cli"))
    parser.add_argument("--agent", action="append", required=True, metavar="ID=EXE")
    parser.add_argument("--startup-timeout", type=float, default=30, help="bounded wait for first PTY bytes (seconds)")
    parser.add_argument("--resume-agent", action="append", default=[], help="also verify cold exact resume for this ID (requires persisted native history)")
    parser.add_argument("--verify-notifications", action="store_true", help="also require setup, owned runtime context, idempotent probe and rollback")
    options = parser.parse_args()
    cli = options.cli.resolve(strict=True)
    # Resolve macOS /var -> /private/var before strict no-symlink installers.
    root = Path(tempfile.mkdtemp(prefix="agentport-nine-smoke-")).resolve()
    home, project = root / "home", root / "project"
    home.mkdir(mode=0o700)
    project.mkdir(mode=0o700)
    # Deliberate allowlist: do not inherit API keys, provider roots, extensions,
    # credential overrides, or user login-shell configuration into the smoke.
    env = {
        "HOME": str(home), "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "SHELL": "/bin/sh", "TERM": "xterm-256color", "LANG": "en_US.UTF-8",
        "AGENTPORT_DATA_DIR": str(root / "data"),
        "AGENTPORT_HOST_BIN": str(cli.with_name("agentport-host")),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local/share"),
        "XDG_CACHE_HOME": str(home / ".cache"),
    }

    def call(*args):
        result = subprocess.run([str(cli), "--json", *args], env=env, cwd=project,
                                capture_output=True, text=True, timeout=40)
        if result.returncode:
            raise RuntimeError(f"{args[0:2]} failed: {result.stderr[-1500:]}")
        return json.loads(result.stdout)

    project_id = call("project", "add", str(project))["id"]
    results = []
    for specification in options.agent:
        agent, executable = specification.split("=", 1)
        executable = str(Path(executable).absolute())
        row = {"agent": agent, "executable": executable, "status": "failed"}
        session_id = None
        try:
            probe = call("probe", agent, "--path", executable)
            if isinstance(probe, list):
                probe = probe[0]
            row["probe"] = probe["state"]
            if probe["state"] != "available":
                raise RuntimeError(probe.get("reason", "probe unavailable"))
            row["version"] = probe["install"]["version"]
            if options.verify_notifications:
                setup = probe.get("notificationSetup", {})
                row["notificationSetup"] = setup
                if setup.get("state") not in ("ready", "degraded"):
                    raise RuntimeError("notification setup did not install safely")
                repeated = call("probe", agent, "--path", executable)
                if isinstance(repeated, list):
                    repeated = repeated[0]
                if repeated.get("notificationSetup", {}).get("state") != setup["state"]:
                    raise RuntimeError("repeated notification setup changed readiness")
            launch = call("session", "new", "--project", project_id, "--agent", agent)
            session_id = launch["id"]
            row["sessionId"] = session_id
            row["nativeIdAssigned"] = launch["agentSessionId"] is not None
            row["resumePrecision"] = launch["resumePrecision"]
            row["command"] = launch["command"]
            # Cold CLIs may discover models/extract native modules before their
            # first render. Poll with a deadline instead of assuming 3 seconds.
            deadline = time.monotonic() + options.startup_timeout
            row["ptyBytes"] = 0
            while time.monotonic() < deadline:
                # Replay is an in-memory Host API, not an output.log file.
                replay = call("session", "read", session_id, "--timeout", "2")
                row["ptyBytes"] = replay["bytes"]
                if row["ptyBytes"] or replay["exit"] is not None:
                    break
            status = call("session", "status", session_id)
            row["lifecycle"] = status["session"]["lifecycle"]
            if options.verify_notifications:
                session_dir = root / "data" / "sessions" / session_id
                cfg = json.loads((session_dir / "host.json").read_text())
                bindings = dict(cfg["env"])
                context_path = Path(bindings["AGENTPORT_NOTIFICATION_CONTEXT_FILE"])
                context = json.loads(context_path.read_text())
                if (context.get("sessionId") != session_id or
                        context.get("runId") != bindings["AGENTPORT_RUN_ID"] or
                        not context.get("ownerPid") or
                        context.get("nativeSessionId") != launch["agentSessionId"]):
                    raise RuntimeError("managed runtime context was not bound to the actual child")
                row["notificationContextBound"] = True
            replay_again = call("session", "read", session_id, "--timeout", "1")
            row["reattachBytes"] = replay_again["bytes"]
            if options.verify_notifications:
                # Isolated unauthenticated startup only; retain native loader
                # diagnostics for review instead of treating any PTY bytes as proof.
                (root / f"{agent}-startup.txt").write_text(replay_again.get("output", ""))
            if not launch["childAlive"] or row["lifecycle"] != "running" or not row["ptyBytes"] or not row["reattachBytes"]:
                raise RuntimeError("real CLI did not remain running with PTY output")
            if agent in options.resume_agent:
                call("session", "stop", session_id)
                resumed = call("session", "restart", session_id)
                row["resumeExact"] = (resumed["resumePrecision"] == "exact"
                                      and resumed["agentSessionId"] == launch["agentSessionId"])
                deadline = time.monotonic() + options.startup_timeout
                row["resumePtyBytes"] = 0
                while time.monotonic() < deadline:
                    replay = call("session", "read", session_id, "--timeout", "2")
                    row["resumePtyBytes"] = replay["bytes"]
                    if replay["bytes"] or replay["exit"] is not None:
                        break
                if not row["resumeExact"] or not row["resumePtyBytes"]:
                    raise RuntimeError("cold resume lost the native ID or failed to render")
            row["status"] = "passed"
        except (RuntimeError, subprocess.TimeoutExpired, KeyError) as error:
            row["error"] = str(error)
        finally:
            if session_id:
                try:
                    call("session", "stop", session_id)
                    row["stopped"] = True
                    if options.verify_notifications:
                        rolled_back = call("notification", "rollback", agent)
                        if rolled_back.get("state") != "unavailable":
                            raise RuntimeError("notification rollback did not deactivate integration")
                        row["notificationRolledBack"] = True
                except (RuntimeError, subprocess.TimeoutExpired) as error:
                    row["status"] = "failed"
                    row["stopError"] = str(error)
        results.append(row)
    report = {"root": str(root), "scope": "isolated unauthenticated PTY startup; no input/model turns", "results": results}
    (root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0 if all(row["status"] == "passed" for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
