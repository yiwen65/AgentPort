#!/usr/bin/env python3
"""End-to-end smoke test for the AgentPort Sessions MCP server.

Runs a real `agentport-mcp serve --stdio` process against a throwaway data
directory, drives it with JSON-RPC over stdio, and uses the Generic Shell agent
so the check never touches a user Session, an API key, or the release data root.

Usage:
    python3 scripts/test-agentport-mcp.py [--binary target/debug/agentport-mcp]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


class McpClient:
    def __init__(self, binary: Path, data_dir: Path) -> None:
        env = dict(os.environ)
        env["AGENTPORT_DATA_DIR"] = str(data_dir)
        env.pop("AGENTPORT_SESSION_ID", None)
        self.proc = subprocess.Popen(
            [str(binary), "serve", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            bufsize=1,
        )
        self.next_id = 1

    def send(self, method: str, params: dict | None = None) -> dict:
        message = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        self.next_id += 1
        if params is not None:
            message["params"] = params
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()
        assert self.proc.stdout is not None
        while True:
            line = self.proc.stdout.readline()
            if not line:
                stderr = self.proc.stderr.read() if self.proc.stderr else ""
                raise RuntimeError(f"MCP server closed the stream. stderr:\n{stderr}")
            response = json.loads(line)
            if response.get("id") == message["id"]:
                return response

    def notify(self, method: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
        self.proc.stdin.flush()

    def call(self, name: str, arguments: dict) -> tuple[dict, bool]:
        response = self.send("tools/call", {"name": name, "arguments": arguments})
        result = response.get("result", {})
        text = result.get("content", [{}])[0].get("text", "{}")
        payload = json.loads(text)
        return payload, bool(result.get("isError"))

    def close(self) -> None:
        if self.proc.stdin:
            self.proc.stdin.close()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f"  ok  {message}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default=str(REPO / "target/debug/agentport-mcp"))
    parser.add_argument("--agent", default="shell")
    args = parser.parse_args()

    binary = Path(args.binary)
    if not binary.is_file():
        print(f"missing binary: {binary}\nrun: cargo build -p agentport-mcp", file=sys.stderr)
        return 2

    data_dir = Path(tempfile.mkdtemp(prefix="agentport-mcp-e2e-"))
    project = data_dir / "project"
    project.mkdir()
    (project / "README.md").write_text("# mcp e2e\n")
    client = McpClient(binary, data_dir)
    session_id = None
    try:
        print("initialize", flush=True)
        init = client.send(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "agentport-mcp-smoke", "version": "0"},
            },
        )
        check(init["result"]["protocolVersion"] == "2025-06-18", "protocol version negotiated")
        check(init["result"]["serverInfo"]["name"] == "agentport-mcp", "server identity")
        client.notify("notifications/initialized")

        print("tools/list")
        tools = client.send("tools/list")["result"]["tools"]
        names = {tool["name"] for tool in tools}
        expected = {
            "list_agents",
            "resolve_project",
            "list_sessions",
            "session_status",
            "create_session",
            "send_prompt",
            "wait_for_task",
            "read_output",
            "cancel_turn",
            "terminate_session",
            "open_pane",
        }
        check(names == expected, f"exactly the v1 tool set ({len(names)} tools)")
        check("send_input" not in names, "raw byte input is not exposed")

        print("list_agents")
        agents, is_error = client.call("list_agents", {"probe": True})
        check(not is_error and "agents" in agents, "agents listed")
        shell = next((a for a in agents["agents"] if a["agent"] == "shell"), None)
        check(shell is not None and shell["installed"], "generic shell agent is probed")

        print("resolve_project")
        resolved, is_error = client.call("resolve_project", {"path": str(project)})
        check(not is_error and resolved["created"], "project registered")
        project_id = resolved["projectId"]
        again, _ = client.call("resolve_project", {"path": str(project)})
        check(again["projectId"] == project_id and not again["created"], "resolve is idempotent")

        print("create_session + first prompt")
        created, is_error = client.call(
            "create_session",
            {
                "agent": args.agent,
                "projectId": project_id,
                "title": "mcp e2e",
                "prompt": "echo MCP-E2E-OK",
            },
        )
        check(not is_error, f"session created: {created.get('sessionId')}")
        session_id = created["sessionId"]
        check(created["promptSent"], "first prompt sent after the ready gate")
        # Delegation is unattended: the default must be the Agent's own
        # full-permission mode, not the CLI's interactive prompts.
        check(
            created["permissionMode"] == "bypass",
            f"delegated Session defaults to full permissions ({created['permissionMode']})",
        )

        print("wait_for_task")
        waited, is_error = client.call(
            "wait_for_task", {"sessionId": session_id, "timeoutMs": 20000}
        )
        check(not is_error, "wait_for_task returned")
        check(
            waited["state"] in {"idle", "needs_input", "timeout"},
            f"wait state is {waited['state']} (source={waited['source']})",
        )
        check(
            "MCP-E2E-OK" in waited.get("outputTail", ""),
            "output tail contains the command echo",
        )

        print("read_output")
        output, is_error = client.call("read_output", {"sessionId": session_id, "tailBytes": 4096})
        check(not is_error and "MCP-E2E-OK" in output["text"], "read_output returns the marker")

        print("session_status")
        status, is_error = client.call("session_status", {"sessionId": session_id})
        check(not is_error and status["sessionId"] == session_id, "status read")

        print("scope guard")
        foreign, is_error = client.call("read_output", {"sessionId": "ses_not_mine"})
        check(is_error and foreign["error"]["code"] == "session_not_owned", "foreign session rejected")
        native, is_error = client.call(
            "create_session",
            {"agent": args.agent, "projectId": project_id, "permission": "native", "title": "native"},
        )
        check(not is_error, "an explicit native permission is still accepted")
        check(native["permissionMode"] == "native", "native is not silently widened")
        client.call("terminate_session", {"sessionId": native["sessionId"]})
        bad, is_error = client.call(
            "create_session",
            {"agent": args.agent, "projectId": project_id, "permission": "sandbox"},
        )
        check(is_error and bad["error"]["code"] == "invalid_permission", "unknown permission rejected")

        print("open_pane")
        pane, is_error = client.call("open_pane", {"sessionId": session_id})
        check(not is_error and pane["queued"], "pane command queued")
        queue = data_dir / "mcp" / "ui-commands.jsonl"
        check(queue.is_file(), "ui command queue written")

        print("completion is not guessed (regression: quiet window vs a running command)")
        # A prompt that runs for seconds must never be reported as finished
        # early: `wait_for_task` has to wait for a *newer* status transition.
        begun = time.monotonic()
        prompted, is_error = client.call(
            "send_prompt", {"sessionId": session_id, "text": "sleep 4; echo SECOND-42-END"}
        )
        check(not is_error, "second prompt accepted")
        second, is_error = client.call(
            "wait_for_task", {"sessionId": session_id, "timeoutMs": 30000}
        )
        elapsed = time.monotonic() - begun
        check(not is_error, f"second wait returned {second['state']}")
        check(
            second["state"] == "idle",
            f"second wait settled as idle (source={second['source']}, {elapsed:.1f}s)",
        )
        check(
            elapsed >= 3.5,
            f"wait did not return before the command finished ({elapsed:.1f}s)",
        )
        check(
            "SECOND-42-END" in second.get("outputTail", ""),
            "output tail proves the command actually completed",
        )

        print("a repeated wait never reports a false turn boundary")
        begun = time.monotonic()
        repeat, is_error = client.call(
            "wait_for_task", {"sessionId": session_id, "timeoutMs": 20000}
        )
        repeat_elapsed = time.monotonic() - begun
        check(not is_error and repeat["state"] == "idle", "repeat wait settles as idle")
        # Shell reports no turn boundary, so the honest answer keeps the
        # low-confidence label instead of being cached as a completion.
        check(
            repeat["confidence"] == "low" and repeat["source"] == "quiet_window",
            "repeat verdict stays low confidence for an Agent without turn signals",
        )
        check(repeat_elapsed < 15.0, f"repeat wait stayed bounded ({repeat_elapsed:.1f}s)")

        print("terminate_session")
        stopped, is_error = client.call(
            "terminate_session", {"sessionId": session_id, "graceMs": 2000}
        )
        check(not is_error and stopped["stopped"], "session stopped")
        after, is_error = client.call("wait_for_task", {"sessionId": session_id, "timeoutMs": 5000})
        check(not is_error and after["state"] == "exited", "an ended Session reports exited")
        output_after, is_error = client.call("read_output", {"sessionId": session_id})
        check(
            not is_error and output_after.get("ended") is True,
            "read_output reports the Session ended instead of failing",
        )
        owned, is_error = client.call("list_sessions", {})
        check(
            not is_error
            and all(s["sessionId"] != session_id for s in owned["sessions"]) is False,
            "terminated Session is still listed by the backend",
        )
        session_id = None

        print("\nall MCP end-to-end checks passed")
        return 0
    finally:
        if session_id is not None:
            try:
                client.call("terminate_session", {"sessionId": session_id})
            except Exception:
                pass
        client.close()
        shutil.rmtree(data_dir, ignore_errors=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as error:
        print(f"\nFAILED: {error}", file=sys.stderr)
        sys.exit(1)
