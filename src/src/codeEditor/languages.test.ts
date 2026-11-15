import { describe, expect, it } from "vitest";
import { detectLanguage } from "./languages";

describe("detectLanguage", () => {
  it("detects common extensions case-insensitively", () => {
    expect(detectLanguage("/a/b/App.TSX")).toBe("tsx");
    expect(detectLanguage("/a/b/lib.rs")).toBe("rust");
    expect(detectLanguage("/a/b/config.yaml")).toBe("yaml");
    expect(detectLanguage("/a/b/styles.module.scss")).toBe("scss");
    expect(detectLanguage("/a/b/schema.jsonc")).toBe("jsonc");
  });

  it("detects special filenames", () => {
    expect(detectLanguage("/a/b/Dockerfile")).toBe("dockerfile");
    expect(detectLanguage("/a/b/.env.local")).toBe("ini");
    expect(detectLanguage("/a/b/.editorconfig")).toBe("ini");
  });

  it("uses shebangs for extensionless files", () => {
    expect(detectLanguage("/a/bin/run", "#!/usr/bin/env python3")).toBe("python");
    expect(detectLanguage("/a/bin/run", "#!/bin/bash")).toBe("shell");
    expect(detectLanguage("/a/bin/run", "#!/usr/bin/env node")).toBe("javascript");
    expect(detectLanguage("/a/bin/run", "not a script")).toBeNull();
  });

  it("falls back to plain text for unsupported files", () => {
    expect(detectLanguage("/a/b/query.graphql")).toBeNull();
    expect(detectLanguage("/a/b/Makefile")).toBeNull();
    expect(detectLanguage("/a/b/notes.txt")).toBeNull();
  });
});
