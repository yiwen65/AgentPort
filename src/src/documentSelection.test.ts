// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { previewSelectionLineRange } from "./documentSelection";

vi.mock("./terminals", () => ({ insertTextIntoTerminal: vi.fn() }));

afterEach(() => { document.body.innerHTML = ""; });

function fixture() {
  const root = document.createElement("div");
  root.innerHTML = '<span data-source-line="4">alpha\n</span><span data-source-line="5">beta</span><button>Retry image</button>';
  document.body.append(root);
  return root;
}

it("excludes the next line when a range ends at that element's start boundary", () => {
  const root = fixture();
  const range = document.createRange();
  range.setStart(root.firstChild!, 0);
  range.setEnd(root.children[1], 0);
  expect(previewSelectionLineRange(root, range)).toEqual({ startLine: 4, endLine: 4 });
});

it("excludes the previous line when a range starts at its text end", () => {
  const root = fixture();
  const range = document.createRange();
  range.setStart(root.firstChild!.firstChild!, 6);
  range.setEnd(root.children[1].firstChild!, 4);
  expect(previewSelectionLineRange(root, range)).toEqual({ startLine: 5, endLine: 5 });
});

it("does not attribute preview controls or collapsed selections to source lines", () => {
  const root = fixture();
  const range = document.createRange();
  range.selectNodeContents(root.querySelector("button")!);
  expect(previewSelectionLineRange(root, range)).toBeNull();
  range.collapse(true);
  expect(previewSelectionLineRange(root, range)).toBeNull();
});
