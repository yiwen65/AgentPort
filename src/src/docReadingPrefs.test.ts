// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DOC_CODE_LINE_NUMBERS_STORAGE_KEY,
  DOC_CODE_WRAP_STORAGE_KEY,
  DOC_READING_THEME_STORAGE_KEY,
  restoreDocReadingPrefs,
  setDocCodeLineNumbers,
  setDocCodeWrap,
  setDocReadingTheme,
} from "./docReadingPrefs";
import { getState, setState } from "./store";

describe("docReadingPrefs", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setState({
      docReadingTheme: "terminal",
      docCodeLineNumbers: false,
      docCodeWrap: true,
    });
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("restores persisted preferences", () => {
    window.localStorage.setItem(DOC_READING_THEME_STORAGE_KEY, "night");
    window.localStorage.setItem(DOC_CODE_LINE_NUMBERS_STORAGE_KEY, "1");
    window.localStorage.setItem(DOC_CODE_WRAP_STORAGE_KEY, "0");
    restoreDocReadingPrefs();
    expect(getState().docReadingTheme).toBe("night");
    expect(getState().docCodeLineNumbers).toBe(true);
    expect(getState().docCodeWrap).toBe(false);
  });

  it("falls back for corrupt values", () => {
    window.localStorage.setItem(DOC_READING_THEME_STORAGE_KEY, "neon");
    window.localStorage.setItem(DOC_CODE_LINE_NUMBERS_STORAGE_KEY, "maybe");
    window.localStorage.setItem(DOC_CODE_WRAP_STORAGE_KEY, "maybe");
    restoreDocReadingPrefs();
    expect(getState().docReadingTheme).toBe("terminal");
    expect(getState().docCodeLineNumbers).toBe(false);
    expect(getState().docCodeWrap).toBe(true);
  });

  it("persists setter changes", () => {
    setDocReadingTheme("paper");
    setDocCodeLineNumbers(true);
    setDocCodeWrap(false);
    expect(window.localStorage.getItem(DOC_READING_THEME_STORAGE_KEY)).toBe("paper");
    expect(window.localStorage.getItem(DOC_CODE_LINE_NUMBERS_STORAGE_KEY)).toBe("1");
    expect(window.localStorage.getItem(DOC_CODE_WRAP_STORAGE_KEY)).toBe("0");
    expect(getState().docReadingTheme).toBe("paper");
  });
});
