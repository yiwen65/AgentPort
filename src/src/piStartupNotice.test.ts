import { describe, expect, it } from "vitest";
import { PiStartupNoticeFilter } from "./piStartupNotice";

const id = "pi-native-session";
const notice = new TextEncoder().encode(
  `\x1b[33mWarning: No project session found with id '${id}'; creating a new session with that id.\x1b[39m\r\n`,
);

describe("PiStartupNoticeFilter", () => {
  it("removes the exact startup notice even when it spans PTY frames", () => {
    const filter = new PiStartupNoticeFilter(id);
    expect(Array.from(filter.feed(notice.slice(0, 37)))).toEqual([]);
    expect(Array.from(filter.feed(new Uint8Array([...notice.slice(37), ...new TextEncoder().encode("Pi ready\r\n")])))).toEqual(
      Array.from(new TextEncoder().encode("Pi ready\r\n")),
    );
    expect(Array.from(filter.finish())).toEqual([]);
  });

  it("keeps other first-line diagnostics", () => {
    const filter = new PiStartupNoticeFilter(id);
    const diagnostic = new TextEncoder().encode("Warning: provider authentication failed\r\n");
    expect(Array.from(filter.feed(diagnostic))).toEqual(Array.from(diagnostic));
  });
});
