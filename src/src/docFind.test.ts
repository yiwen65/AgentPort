// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildFindText, findMatchesIn, rangeForMatch } from "./docFind";

function fixture(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML =
    '<p><span data-source-line="1">Hello world</span></p>' +
    '<p><span data-source-line="2">hello again</span></p>' +
    '<p><span data-search-skip="true">ignore hello</span></p>';
  return root;
}

describe("docFind", () => {
  it("collects source text in order and skips controls", () => {
    const map = buildFindText(fixture());
    expect(map.text).toBe("Hello world\nhello again");
    expect(findMatchesIn(map.text, "hello")).toEqual([0, 12]);
  });

  it("maps matches to DOM ranges", () => {
    const map = buildFindText(fixture());
    const matches = findMatchesIn(map.text, "hello");
    const second = rangeForMatch(map, matches[1], "hello".length);
    expect(second?.toString()).toBe("hello");
    expect((second?.startContainer as Text).nodeValue).toBe("hello again");
  });
});
