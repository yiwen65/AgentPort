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
