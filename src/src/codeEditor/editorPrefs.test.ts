// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DOC_EDITOR_INDENT_STORAGE_KEY,
  DOC_EDITOR_THEME_STORAGE_KEY,
  DOC_EDITOR_WRAP_STORAGE_KEY,
  effectiveIndent,
  restoreDocEditorPrefs,
  setDocEditorIndent,
  setDocEditorIndentStyle,
  setDocEditorTheme,
  setDocEditorWhitespace,
  setDocEditorWrap,
} from "./editorPrefs";
import { getState, setState } from "../store";

describe("editor preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setState({
      docEditorTheme: "follow",
      docEditorIndent: "auto",
      docEditorIndentStyle: "auto",
      docEditorWrap: false,
      docEditorWhitespace: false,
    });
  });

  it("restores defaults when storage is empty or corrupt", () => {
    window.localStorage.setItem(DOC_EDITOR_THEME_STORAGE_KEY, "unknown");
    window.localStorage.setItem(DOC_EDITOR_INDENT_STORAGE_KEY, "3");
    window.localStorage.setItem(DOC_EDITOR_WRAP_STORAGE_KEY, "maybe");
    restoreDocEditorPrefs();
    expect(getState().docEditorTheme).toBe("follow");
    expect(getState().docEditorIndent).toBe("auto");
    expect(getState().docEditorIndentStyle).toBe("auto");
    expect(getState().docEditorWrap).toBe(false);
    expect(getState().docEditorWhitespace).toBe(false);
  });

  it("persists theme, indentation, wrap and whitespace", () => {
    setDocEditorTheme("vitesse-dark");
    setDocEditorIndent(4);
    setDocEditorIndentStyle("tabs");
    setDocEditorWrap(true);
    setDocEditorWhitespace(true);
    expect(window.localStorage.getItem(DOC_EDITOR_THEME_STORAGE_KEY)).toBe("vitesse-dark");
    expect(window.localStorage.getItem(DOC_EDITOR_INDENT_STORAGE_KEY)).toBe("4");
    expect(window.localStorage.getItem(DOC_EDITOR_WRAP_STORAGE_KEY)).toBe("1");

    setState({
      docEditorTheme: "follow",
      docEditorIndent: "auto",
      docEditorIndentStyle: "auto",
      docEditorWrap: false,
      docEditorWhitespace: false,
    });
    restoreDocEditorPrefs();
    expect(getState().docEditorTheme).toBe("vitesse-dark");
    expect(getState().docEditorIndent).toBe(4);
    expect(getState().docEditorIndentStyle).toBe("tabs");
    expect(getState().docEditorWrap).toBe(true);
    expect(getState().docEditorWhitespace).toBe(true);
  });

  it("resolves automatic indentation per language", () => {
    expect(effectiveIndent({ indent: "auto", indentStyle: "auto" }, "python")).toEqual({
      width: 4,
      useSpaces: true,
    });
    expect(effectiveIndent({ indent: "auto", indentStyle: "auto" }, "go")).toEqual({
      width: 2,
      useSpaces: false,
    });
    expect(effectiveIndent({ indent: "auto", indentStyle: "auto" }, "typescript")).toEqual({
      width: 2,
      useSpaces: true,
    });
    expect(effectiveIndent({ indent: 8, indentStyle: "tabs" }, "python")).toEqual({
      width: 8,
      useSpaces: false,
    });
  });
});
