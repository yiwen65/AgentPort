import { describe, expect, it } from "vitest";
import { resolveEditorTheme } from "./themePref";

describe("resolveEditorTheme", () => {
  it("follows the reading theme in follow mode", () => {
    expect(resolveEditorTheme("follow", "paper", "dark")).toBe("min-light");
    expect(resolveEditorTheme("follow", "night", "light")).toBe("vitesse-dark");
    expect(resolveEditorTheme("follow", "terminal", "light")).toBe(
      "github-light-default",
    );
    expect(resolveEditorTheme("follow", "terminal", "dark")).toBe(
      "github-dark-default",
    );
  });

  it("keeps an explicit theme regardless of the reading surface", () => {
    expect(resolveEditorTheme("vitesse-dark", "paper", "light")).toBe("vitesse-dark");
  });
});
