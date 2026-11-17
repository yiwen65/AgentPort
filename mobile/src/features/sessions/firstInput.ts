/**
 * Captures the first non-empty command line without interfering with PTY I/O.
 * Mirrors the desktop terminal seam so both clients auto-title a new Session
 * from the same first submitted input.
 */

const MAX_CAPTURE_LENGTH = 240;

type EscapeState = "none" | "esc" | "csi" | "osc" | "oscEsc" | "string" | "stringEsc";

export interface FirstInputCapture {
  buffer: string;
  submitted: boolean;
  escape: EscapeState;
}

export function createFirstInputCapture(): FirstInputCapture {
  return { buffer: "", submitted: false, escape: "none" };
}

/** Returns the submitted line on the first Enter that ends a non-empty buffer. */
export function captureFirstSubmittedInput(capture: FirstInputCapture, data: string): string | null {
  if (capture.submitted) return null;

  for (const char of data) {
    if (capture.escape === "esc") {
      if (char === "[") capture.escape = "csi";
      else if (char === "]") capture.escape = "osc";
      else if (char === "P" || char === "^" || char === "_") capture.escape = "string";
      else capture.escape = "none";
      continue;
    }
    if (capture.escape === "csi") {
      if (char >= "@" && char <= "~") capture.escape = "none";
      continue;
    }
    if (capture.escape === "osc" || capture.escape === "string") {
      if (char === "\x07") capture.escape = "none";
      else if (char === "\x1b") capture.escape = capture.escape === "osc" ? "oscEsc" : "stringEsc";
      continue;
    }
    if (capture.escape === "oscEsc" || capture.escape === "stringEsc") {
      // ST terminates the payload; any other character is still payload.
      if (char === "\\" || char === "\x07") capture.escape = "none";
      else capture.escape = capture.escape === "oscEsc" ? "osc" : "string";
      continue;
    }
    if (char === "\x1b") {
      capture.escape = "esc";
      continue;
    }
    if (char === "\r" || char === "\n") {
      const input = capture.buffer.trim();
      if (input) {
        capture.submitted = true;
        return input;
      }
      continue;
    }
    if (char === "\x7f" || char === "\b") {
      capture.buffer = Array.from(capture.buffer).slice(0, -1).join("");
      continue;
    }
    if (char.codePointAt(0)! >= 0x20 && capture.buffer.length < MAX_CAPTURE_LENGTH) {
      capture.buffer += char;
    }
  }
  return null;
}
