import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("links the Rust static library without copying it into the iOS app resources", () => {
  const project = readFileSync("src-tauri/gen/apple/agentport-mobile.xcodeproj/project.pbxproj", "utf8");
  const spec = readFileSync("src-tauri/gen/apple/project.yml", "utf8");
  expect(project).toContain("libapp.a in Frameworks");
  expect(project).not.toContain("libapp.a in Resources");
  expect(spec).toMatch(/- path: Externals\n\s+buildPhase: none/);
  expect(spec).toMatch(/- framework: libapp\.a\n\s+embed: false/);
});

it("keeps bundle-level iPhone orientations unlocked while the primary screen is locked at runtime", () => {
  // Dropping landscape from the plist re-hides terminal rotation (df6fe42 had
  // to restore it); portrait-on-primary is enforced by the Tao view controller
  // mask from mobile_set_terminal_rotation instead.
  const plist = readFileSync("src-tauri/gen/apple/agentport-mobile_iOS/Info.plist", "utf8");
  const iphoneOrientations = plist.split("<key>UISupportedInterfaceOrientations~ipad</key>")[0];
  for (const orientation of [
    "UIInterfaceOrientationPortrait",
    "UIInterfaceOrientationLandscapeLeft",
    "UIInterfaceOrientationLandscapeRight",
  ]) {
    expect(iphoneOrientations).toContain(`<string>${orientation}</string>`);
  }
  const spec = readFileSync("src-tauri/gen/apple/project.yml", "utf8");
  expect(spec).toMatch(/UISupportedInterfaceOrientations:\n\s+- UIInterfaceOrientationPortrait\n\s+- UIInterfaceOrientationLandscapeLeft\n\s+- UIInterfaceOrientationLandscapeRight/);
});
