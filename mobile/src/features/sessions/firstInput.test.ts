import { describe, expect, it } from "vitest";
import { captureFirstSubmittedInput, createFirstInputCapture } from "./firstInput";

describe("captureFirstSubmittedInput", () => {
  it("submits the first non-empty trimmed line exactly once", () => {
    const capture = createFirstInputCapture();
    expect(captureFirstSubmittedInput(capture, "  请检查自动命名  ")).toBeNull();
    expect(captureFirstSubmittedInput(capture, "\r")).toBe("请检查自动命名");
    expect(captureFirstSubmittedInput(capture, "second line\r")).toBeNull();
  });

  it("ignores empty Enters until text is submitted", () => {
    const capture = createFirstInputCapture();
    expect(captureFirstSubmittedInput(capture, "\r")).toBeNull();
    expect(captureFirstSubmittedInput(capture, "task\r")).toBe("task");
  });

  it("applies backspace and ignores navigation/control sequences", () => {
    const capture = createFirstInputCapture();
    captureFirstSubmittedInput(capture, "\x1b[Aab\x7fc\x08");
    captureFirstSubmittedInput(capture, "\t\x03");
    expect(captureFirstSubmittedInput(capture, "\r")).toBe("a");
    expect(captureFirstSubmittedInput(capture, "more\r")).toBeNull();
  });

  it("does not leak terminal-generated OSC replies into the title", () => {
    const capture = createFirstInputCapture();
    captureFirstSubmittedInput(capture, "\x1b]10;rgb:d4d4/d4d4/");
    captureFirstSubmittedInput(capture, "d4d4\x07");
    expect(captureFirstSubmittedInput(capture, "请修复自动命名\r")).toBe("请修复自动命名");
  });

  it("caps the captured line at 240 characters", () => {
    const capture = createFirstInputCapture();
    captureFirstSubmittedInput(capture, "x".repeat(300));
    expect(captureFirstSubmittedInput(capture, "\r")).toBe("x".repeat(240));
  });
});
