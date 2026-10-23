import { describe, expect, it } from "vitest";
import { relativeTimeLabel } from "./relative-time";

describe("relativeTimeLabel", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");

  it("picks the largest readable unit", () => {
    expect(relativeTimeLabel("2026-10-23T11:55:00Z", now)).toBe("5 minutes ago");
    expect(relativeTimeLabel("2026-10-23T09:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTimeLabel("2026-10-20T12:00:00Z", now)).toBe("3 days ago");
    expect(relativeTimeLabel("2026-06-23T12:00:00Z", now)).toBe("4 months ago");
    expect(relativeTimeLabel("2023-10-23T12:00:00Z", now)).toBe("3 years ago");
  });

  it("returns text that is not a date unchanged", () => {
    expect(relativeTimeLabel("yesterday-ish", now)).toBe("yesterday-ish");
  });
});
