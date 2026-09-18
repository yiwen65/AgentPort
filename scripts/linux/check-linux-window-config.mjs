#!/usr/bin/env node
// Guards the Linux window-chrome override: tauri.linux.conf.json must stay
// tauri.conf.json's windows[0] plus exactly { "decorations": false }. The
// platform file is auto-discovered by the Tauri CLI and tauri-build for Linux
// targets and merged with JSON-merge-patch semantics (RFC 7386), so the
// windows array is REPLACED wholesale — a drifted override would silently
// change the Linux release window (size, transparency, drag-drop, ...).
// Run from anywhere; resolves the repo root from its own location.
// Exit 0 = in sync; exit 1 = drift (prints the expected override).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const linux = JSON.parse(
  readFileSync(join(root, "src-tauri", "tauri.linux.conf.json"), "utf8"),
);

const canonical = (value) =>
  JSON.stringify(value, (key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val,
  );

const baseWindow = conf.app?.windows?.[0];
const linuxWindow = linux.app?.windows?.[0];
if (!baseWindow || !linuxWindow) {
  console.error("check-linux-window-config: missing windows[0] in one of the configs");
  process.exit(1);
}

const expected = { ...baseWindow, decorations: false };
if (canonical(linuxWindow) !== canonical(expected)) {
  console.error(
    "check-linux-window-config: tauri.linux.conf.json windows[0] drifted from\n" +
      "tauri.conf.json. It must equal the base window plus \"decorations\": false.\n" +
      `expected: ${canonical(expected)}\n` +
      `actual:   ${canonical(linuxWindow)}`,
  );
  process.exit(1);
}

if (linux.bundle?.createUpdaterArtifacts !== false) {
  console.error(
    "check-linux-window-config: tauri.linux.conf.json must keep " +
      "bundle.createUpdaterArtifacts = false (Linux ships no updater feed).",
  );
  process.exit(1);
}

console.log(
  `linux window override in sync (decorations: false, ${baseWindow.width}x${baseWindow.height})`,
);
