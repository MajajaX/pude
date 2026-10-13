import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW_TITLE, windowTitleForWorkspace } from "./window-title";

describe("windowTitleForWorkspace", () => {
  it("names the window after the opened folder", () => {
    expect(windowTitleForWorkspace("/Users/me/projects/officialwebsite", { platform: "posix" })).toBe("pude - officialwebsite");
    expect(windowTitleForWorkspace("/Users/me/projects/officialwebsite/", { platform: "posix" })).toBe("pude - officialwebsite");
    expect(windowTitleForWorkspace("C:\\work\\officialwebsite", { platform: "windows" })).toBe("pude - officialwebsite");
  });

  it("falls back to the default title without a folder", () => {
    expect(windowTitleForWorkspace("")).toBe(DEFAULT_WINDOW_TITLE);
  });
});
