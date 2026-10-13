import { describe, expect, it } from "vitest";
import { errorMessage, gitStatusLabel, hasUnsavedChanges, orderTabsByPinned } from "./core";

describe("pude core helpers", () => {
  it("detects unsaved editor content", () => {
    expect(hasUnsavedChanges("new", "old")).toBe(true);
    expect(hasUnsavedChanges("same", "same")).toBe(false);
  });

  it("keeps pinned tabs first and preserves order within each group", () => {
    const tabs = [
      { id: "un-pinned-1", pinned: false },
      { id: "pinned-1", pinned: true },
      { id: "un-pinned-2" },
      { id: "pinned-2", pinned: true },
    ];

    expect(orderTabsByPinned(tabs).map((tab) => tab.id)).toEqual([
      "pinned-1",
      "pinned-2",
      "un-pinned-1",
      "un-pinned-2",
    ]);
  });

  it("formats staged and worktree status", () => {
    expect(gitStatusLabel("M", " ")).toBe("M");
    expect(gitStatusLabel(null, "M")).toBe("M");
    expect(gitStatusLabel(null, null)).toBe("clean");
  });

  it("keeps backend string errors visible", () => {
    expect(errorMessage("disk full", "fallback")).toBe("disk full");
    expect(errorMessage({ message: "permission denied" }, "fallback")).toBe("permission denied");
    expect(errorMessage({}, "fallback")).toBe("fallback");
  });
});
