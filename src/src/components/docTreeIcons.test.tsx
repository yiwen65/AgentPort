// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DocFileIcon, fileIconSpec } from "./docTreeIcons";

describe("fileIconSpec", () => {
  it("maps special file names before extensions", () => {
    expect(fileIconSpec("AGENTS.md")?.color).toBe("#4f9cc9");
    expect(fileIconSpec("README.md")?.fillPaths?.length).toBeGreaterThan(0);
    expect(fileIconSpec("LICENSE")?.color).toBe("#d8b355");
    expect(fileIconSpec("license.md")?.color).toBe("#d8b355");
    expect(fileIconSpec("COPYING")?.color).toBe("#d8b355");
    expect(fileIconSpec("Makefile")?.color).toBe("#8a97a3");
    expect(fileIconSpec("Dockerfile")?.color).toBe("#0db7ed");
    expect(fileIconSpec(".env")?.color).toBe("#d8b355");
    expect(fileIconSpec(".env.local")?.color).toBe("#d8b355");
    expect(fileIconSpec(".gitignore")?.color).toBe("#f05133");
    expect(fileIconSpec("package.json")?.text).toBe("npm");
  });

  it("maps tsconfig*.json to TypeScript, not JSON", () => {
    expect(fileIconSpec("tsconfig.json")?.text).toBe("TS");
    expect(fileIconSpec("tsconfig.base.json")?.text).toBe("TS");
    expect(fileIconSpec("biome.json")?.text).toBe("{}");
  });

  it("maps common extensions", () => {
    expect(fileIconSpec("app.ts")?.text).toBe("TS");
    expect(fileIconSpec("app.tsx")?.strokePaths?.length).toBeGreaterThan(0); // atom
    expect(fileIconSpec("app.js")?.text).toBe("JS");
    expect(fileIconSpec("lib.rs")?.text).toBe("R");
    expect(fileIconSpec("tool.py")?.text).toBe("Py");
    expect(fileIconSpec("test.sh")?.text).toBe("$");
    expect(fileIconSpec("test.ps1")?.text).toBe(">_");
    expect(fileIconSpec("page.html")?.text).toBe("<>");
    expect(fileIconSpec("site.css")?.text).toBe("#");
    expect(fileIconSpec("notes.md")?.color).toBe("#4f9cc9");
    expect(fileIconSpec("pic.png")?.color).toBe("#a074c4");
    expect(fileIconSpec("font.woff2")?.text).toBe("A");
    expect(fileIconSpec("bundle.zip")?.strokePaths?.length).toBeGreaterThan(0);
    expect(fileIconSpec("doc.pdf")?.color).toBe("#e5534b");
    expect(fileIconSpec("main.go")?.text).toBe("Go");
    expect(fileIconSpec("App.swift")?.text).toBe("S");
    expect(fileIconSpec("Main.kt")?.text).toBe("K");
    expect(fileIconSpec("yarn.lock")?.color).toBe("#d8b355");
  });

  it("falls back to the generic icon for unknown or extensionless names", () => {
    expect(fileIconSpec("weird.xyz")).toBeNull();
    expect(fileIconSpec("noext")).toBeNull();
    expect(fileIconSpec(".hidden")).toBeNull();
  });
});

describe("DocFileIcon", () => {
  afterEach(() => cleanup());

  it("renders the mapped colored glyph", () => {
    const { container } = render(<DocFileIcon name="app.ts" />);
    const text = container.querySelector("svg.doc-file-icon text");
    expect(text?.textContent).toBe("TS");
    expect(text?.getAttribute("fill")).toBe("#3178c6");
  });

  it("renders the generic file icon when unmapped", () => {
    const { container } = render(<DocFileIcon name="weird.xyz" />);
    expect(container.querySelector("svg.doc-file-icon")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
