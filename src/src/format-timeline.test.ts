import { describe, expect, it } from "vitest";
import { formatTimelineTime } from "./format";

describe("formatTimelineTime", () => {
  it("keeps a same-day event compact in local time", () => {
    expect(formatTimelineTime("2026-07-23T12:05:00.000Z", new Date("2026-07-23T12:00:00.000Z")))
      .toMatch(/^\d{2}:\d{2}$/);
  });

  it("includes date and local timezone context across days", () => {
    const text = formatTimelineTime("2026-07-21T01:05:00.000Z", new Date("2026-07-23T12:00:00.000Z"));
    expect(text).toMatch(/2026\/7\/2[01]/);
    expect(text).toContain("（");
  });
});
