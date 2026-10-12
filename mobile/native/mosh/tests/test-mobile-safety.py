#!/usr/bin/env python3
"""Check pinned patches and run real Select early-cancel + atomic-size harness.
Does not modify or rebuild shared platform source trees/artifacts.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[2]
SOURCE = ROOT / "sources/mosh"
PIN = next(line.split("=", 1)[1] for line in (ROOT / "versions.env").read_text().splitlines() if line.startswith("MOSH_COMMIT="))
FILES = ["src/frontend/iosclient.h", "src/frontend/iosclient.cc", "src/frontend/moshiosbridge.h", "src/frontend/moshiosbridge.cc", "src/util/select.h", "src/util/select.cc", "src/util/fatal_assert.h", "src/util/timestamp.h", "src/util/locale_utils.cc"]

HARNESS = r'''
#include "src/frontend/agentport-size.h"
#include "src/util/select.h"
#include <atomic>
#include <thread>
#include <pthread.h>
#include <unistd.h>
void freeze_timestamp() {}
uint64_t frozen_timestamp() { return 0; }
int main() {
  // Atomic snapshot is one coherent row+column pair, even under rapid resize.
  alignas(4) uint32_t packed = (1u << 16) | 500u;
  std::atomic<bool> done{false};
  std::thread writer([&] {
    for (unsigned n = 0; n < 1000000; ++n) {
      unsigned cols = n % 500 + 1;
      __atomic_store_n(&packed, (cols << 16) | (501 - cols), __ATOMIC_RELEASE);
    }
    done.store(true);
  });
  while (!done.load()) {
    winsize snapshot = agentport_read_size(&packed);
    assert(snapshot.ws_col + snapshot.ws_row == 501);
  }
  writer.join();
  // Reproduce cancellation before the pinned native Select handlers exist.
  std::atomic<bool> published{false};
  pthread_t target{};
  std::thread native([&] {
    sigset_t mask; sigemptyset(&mask); sigaddset(&mask, SIGTERM); sigaddset(&mask, SIGWINCH);
    assert(pthread_sigmask(SIG_BLOCK, &mask, nullptr) == 0);
    target = pthread_self(); published.store(true, std::memory_order_release);
    usleep(50000); // caller detaches while mosh_main is still starting
    Select& sel = Select::get_instance();
    sel.add_signal(SIGTERM); sel.add_signal(SIGWINCH);
    sel.select(1000); // pinned pselect(empty mask) delivers pending SIGTERM
    assert(sel.signal(SIGTERM));
  });
  while (!published.load(std::memory_order_acquire)) std::this_thread::yield();
  assert(pthread_kill(target, SIGTERM) == 0);
  native.join();
  return 0;
}
'''

class MobileSafety(unittest.TestCase):
    def prepare(self, directory, android=False):
        for name in FILES:
            destination = Path(directory) / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(subprocess.check_output(["git", "-C", str(SOURCE), "show", PIN + ":" + name]))
        if android:
            subprocess.run(["git", "apply", str(ROOT / "patches/android-mobile.patch")], cwd=directory, check=True)
        subprocess.run(["git", "apply", "--check", str(ROOT / "patches/mobile-safety.patch")], cwd=directory, check=True)
        subprocess.run(["git", "apply", str(ROOT / "patches/mobile-safety.patch")], cwd=directory, check=True)

    def test_patch_applies_to_both_pinned_platforms(self):
        for android in [False, True]:
            with tempfile.TemporaryDirectory() as directory:
                self.prepare(directory, android)
                cc = (Path(directory) / "src/frontend/iosclient.cc").read_text()
                self.assertEqual(cc.count("window_size_storage = agentport_read_size( packed_window_size );"), 2)
                header = (Path(directory) / "src/frontend/iosclient.h").read_text()
                self.assertIn("window_size( &window_size_storage )", header)
                bridge = (Path(directory) / "src/frontend/moshiosbridge.cc").read_text()
                self.assertIn("agentport_mosh_main_v2", bridge)

    def test_build_and_rust_ownership_guards(self):
        for name in ["build-ios-simulator.sh", "build-android-arm64.sh"]:
            script = (ROOT / name).read_text()
            self.assertIn('apply "$ROOT/patches/mobile-safety.patch"', script)
            self.assertIn("agentport_mosh_main_v2$", script)
        self.assertIn("build-ios-simulator.sh", (ROOT / "build-ios-device.sh").read_text())
        rust = (REPO / "mobile/src-tauri/src/mosh/mod.rs").read_text()
        self.assertIn('link_name = "agentport_mosh_main_v2"', rust)
        self.assertIn("winsize: Box<AtomicU32>", rust)
        self.assertNotIn("unsafe impl Sync for SharedWinsize", rust)
        start = rust[rust.index("let native_join = std::thread::spawn"):]
        self.assertLess(start.index("block_native_signals()"), start.index("thread_tx.send(native_thread)"))
        drop = rust[rust.index("impl Drop for MoshSessions"):rust.index("type StateCallback")]
        self.assertIn("retire_session(session)", drop)
        self.assertNotIn("sessions.clear()", drop)

    def test_atomic_snapshot_and_real_select_early_cancel(self):
        with tempfile.TemporaryDirectory() as directory:
            self.prepare(directory)
            source = Path(directory) / "safety.cc"
            source.write_text(HARNESS)
            binary = Path(directory) / "safety"
            flags = ["-std=c++17", "-pthread", "-O1", "-g"]
            sanitizer = os.environ.get("MOSH_SAFETY_SANITIZER")
            if sanitizer:
                self.assertIn(sanitizer, ["thread", "address"])
                flags += ["-fsanitize=" + sanitizer, "-fno-omit-frame-pointer"]
            subprocess.run(["clang++", *flags, "-I", directory, str(source), str(Path(directory) / "src/util/select.cc"), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True, timeout=20)

if __name__ == "__main__":
    unittest.main(verbosity=2)
