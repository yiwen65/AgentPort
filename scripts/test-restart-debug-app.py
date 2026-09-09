#!/usr/bin/env python3
"""No real processes are signalled by these regression tests."""
import importlib.util
from pathlib import Path
import signal
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("restart_debug", Path(__file__).with_name("restart-debug-app.py"))
restart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restart)
GUI = "/checkout with spaces/target/debug/bundle/macos/AgentPort.app/Contents/MacOS/agentport"
HELPERS = f"22 {GUI}-host\n23 {GUI}-connector\n24 {GUI}-remote-bridge\n"


class RestartTests(unittest.TestCase):
    def test_exact_executable_not_prefix_or_argv(self):
        table = f" 21 {GUI}\n" + HELPERS + f"25 /bin/bash {GUI}\n26 /release/AgentPort.app/Contents/MacOS/agentport\n27 /other{GUI}\n"
        self.assertEqual(restart.gui_pids(GUI, table), [21])

    def test_rejects_group_and_invalid_pids(self):
        table = "\n".join(f"{pid} {GUI}" for pid in ["0", "1", "-21", "oops", "21", "21"])
        self.assertEqual(restart.gui_pids(GUI, table), [21])

    def test_only_gui_receives_sigterm_helpers_remain(self):
        read = Mock(side_effect=[f"21 {GUI}\n" + HELPERS, f"21 {GUI}\n" + HELPERS, HELPERS])
        send = Mock()
        restart.stop_gui(GUI, read, send)
        send.assert_called_once_with(21, signal.SIGTERM)

    def test_pid_reused_by_host_is_not_signalled(self):
        read = Mock(side_effect=[f"21 {GUI}", f"21 {GUI}-host", f"21 {GUI}-host"])
        send = Mock()
        restart.stop_gui(GUI, read, send)
        send.assert_not_called()

    def test_no_gui_does_not_signal_anything(self):
        send = Mock()
        restart.stop_gui(GUI, lambda: HELPERS, send)
        send.assert_not_called()

    def test_exit_between_recheck_and_signal_is_safe(self):
        read = Mock(side_effect=[f"21 {GUI}", f"21 {GUI}", HELPERS])
        restart.stop_gui(GUI, read, Mock(side_effect=ProcessLookupError))

    def test_stuck_gui_fails_without_sigkill(self):
        send = Mock()
        with self.assertRaisesRegex(RuntimeError, "refusing to force-kill"):
            restart.stop_gui(GUI, lambda: f"21 {GUI}", send, Mock(), Mock(side_effect=[0, 11]))
        send.assert_called_once_with(21, signal.SIGTERM)

    def test_ps_failure_fails_closed(self):
        send = Mock()
        with self.assertRaises(OSError):
            restart.stop_gui(GUI, Mock(side_effect=OSError("ps failed")), send)
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
