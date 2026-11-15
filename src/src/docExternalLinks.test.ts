// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_LINK_CONFIRM_STORAGE_KEY,
  rememberExternalLinkChoice,
  resetExternalLinkChoice,
  shouldConfirmExternalLink,
} from "./docExternalLinks";

describe("docExternalLinks", () => {
  afterEach(() => {
    resetExternalLinkChoice();
    window.localStorage.clear();
  });

  it("asks by default and remembers the skip choice", () => {
    expect(shouldConfirmExternalLink()).toBe(true);
    rememberExternalLinkChoice();
    expect(window.localStorage.getItem(EXTERNAL_LINK_CONFIRM_STORAGE_KEY)).toBe("skip");
    expect(shouldConfirmExternalLink()).toBe(false);
  });
});
