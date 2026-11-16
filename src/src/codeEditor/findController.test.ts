// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it } from "vitest";
import { findExtensions, replaceAllMatches } from "./findController";

const views: EditorView[] = [];

function viewWith(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [findExtensions] }),
  });
  views.push(view);
  return view;
}

function tokenDoc(count: number): string {
  return Array.from({ length: count }, (_, index) => `a${index}`).join(" ");
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

it("reports when Replace all leaves matches beyond the cap", () => {
  const view = viewWith(tokenDoc(2001));
  const result = replaceAllMatches(
    view,
    {
      query: "a",
      caseSensitive: true,
      regex: false,
      wholeWord: false,
      index: 0,
    },
    "b",
  );

  expect(result).toEqual({ count: 2000, truncated: true });
  expect(view.state.doc.toString().endsWith("a2000")).toBe(true);
});

it("does not report truncation when the document has exactly the cap", () => {
  const view = viewWith(tokenDoc(2000));
  const result = replaceAllMatches(
    view,
    {
      query: "a",
      caseSensitive: true,
      regex: false,
      wholeWord: false,
      index: 0,
    },
    "b",
  );

  expect(result).toEqual({ count: 2000, truncated: false });
  expect(view.state.doc.toString()).not.toContain("a");
});
