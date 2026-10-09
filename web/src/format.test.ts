import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatViews, timeAgo } from "./format";

describe("format", () => {
  it("formats durations like a player does", () => {
    expect(formatDuration(7)).toBe("0:07");
    expect(formatDuration(724)).toBe("12:04");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(184.2 * 1024 * 1024)).toBe("184 MB");
  });
  it("formats views and dates", () => {
    expect(formatViews(1)).toBe("1 view");
    expect(formatViews(1204)).toBe("1,204 views");
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(timeAgo("2026-10-09T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-10-06T12:00:00Z", now)).toBe("3 days ago");
  });
});
