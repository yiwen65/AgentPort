import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appStyles = readFileSync("src/app/styles.css", "utf8");
const fileStyles = readFileSync("src/features/files/session-files.css", "utf8");

describe("file tree paint stability", () => {
  it("does not leave the settled file stage and tree in zero-distance 3D layers", () => {
    expect(appStyles).toMatch(/\.files-stage\.is-visible \{[^}]*transform: none;/s);
    expect(fileStyles).toMatch(/\.files-page-track \{[^}]*transform: none;/s);
    expect(fileStyles).toMatch(/\.files-page-track\.is-preview \{[^}]*transform: translate3d\(/s);
    expect(fileStyles).toMatch(/\.files-page-viewport\[data-file-swiping="true"\] \.files-page-track:not\(.is-preview\) \{[^}]*transform: translate3d\(/s);
  });
});
