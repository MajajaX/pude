import { describe, expect, it } from "vitest";
import { advanceOpenFolderChord, relativePathWithinRoot } from "./explorer-actions";

const key = (keyName: string, modifier: "ctrl" | "meta" | null = null, overrides: Partial<{ altKey: boolean; shiftKey: boolean; defaultPrevented: boolean }> = {}) => ({
  key: keyName,
  ctrlKey: modifier === "ctrl",
  metaKey: modifier === "meta",
  altKey: overrides.altKey ?? false,
  shiftKey: overrides.shiftKey ?? false,
  defaultPrevented: overrides.defaultPrevented ?? false,
});

describe("Explorer actions", () => {
  it("returns relative paths only for items inside the workspace", () => {
    expect(relativePathWithinRoot("C:\\work\\src\\main.ts", "C:\\work")).toBe("src/main.ts");
    expect(relativePathWithinRoot("/work/src/main.ts", "/work")).toBe("src/main.ts");
    expect(relativePathWithinRoot("/workbench/file.ts", "/work")).toBeNull();
    expect(relativePathWithinRoot("C:\\WORK", "c:\\work")).toBe(".");
  });

  it("opens a folder only after the matching two-key chord", () => {
    const pending = advanceOpenFolderChord(null, key("k", "ctrl"), "windows", 100);
    expect(pending.action).toBe("pending");
    expect(pending.consume).toBe(true);

    const opened = advanceOpenFolderChord(pending.state, key("o", "ctrl"), "windows", 400);
    expect(opened.action).toBe("open");
    expect(opened.consume).toBe(true);

    const plainOpen = advanceOpenFolderChord(null, key("o", "ctrl"), "windows", 500);
    expect(plainOpen.action).toBe("none");
    expect(plainOpen.consume).toBe(false);
  });

  it("does not consume editor-handled, mismatched, or expired chords", () => {
    expect(advanceOpenFolderChord(null, key("k", "ctrl", { defaultPrevented: true }), "windows", 100).consume).toBe(false);

    const pending = advanceOpenFolderChord(null, key("k", "meta"), "mac", 100);
    expect(advanceOpenFolderChord(pending.state, key("o", "ctrl"), "mac", 200).action).toBe("none");
    expect(advanceOpenFolderChord(pending.state, key("o", "meta"), "mac", 1_301).action).toBe("none");
  });
});
