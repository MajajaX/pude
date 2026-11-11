import { describe, expect, it } from "vitest";
import { advanceOpenFolderChord, explorerClipboardAction } from "./explorer-actions";
import { relativeWirePath } from "./path-identity";

const key = (
  keyName: string,
  modifier: "ctrl" | "meta" | null = null,
  overrides: Partial<{ altKey: boolean; shiftKey: boolean; defaultPrevented: boolean }> = {},
) => ({
  key: keyName,
  ctrlKey: modifier === "ctrl",
  metaKey: modifier === "meta",
  altKey: overrides.altKey ?? false,
  shiftKey: overrides.shiftKey ?? false,
  defaultPrevented: overrides.defaultPrevented ?? false,
});

describe("Explorer actions", () => {
  it("returns relative paths only for items inside the workspace", () => {
    const windows = { platform: "windows", casePolicy: "insensitive" } as const;
    const posix = { platform: "posix", casePolicy: "sensitive" } as const;
    expect(relativeWirePath("C:\\work\\src\\Main.ts", "c:\\WORK", windows)).toBe("src/Main.ts");
    expect(relativeWirePath("/work/src/main.ts", "/work/", posix)).toBe("src/main.ts");
    expect(relativeWirePath("/workbench/file.ts", "/work", posix)).toBeNull();
    expect(relativeWirePath("/Work/file.ts", "/work", posix)).toBeNull();
    expect(relativeWirePath("C:\\WORK", "c:\\work", windows)).toBe(".");
  });

  it("maps only the platform's primary modifier to Explorer copy and paste", () => {
    expect(explorerClipboardAction(key("c", "meta"), "mac")).toBe("copy");
    expect(explorerClipboardAction(key("V", "meta"), "mac")).toBe("paste");
    expect(explorerClipboardAction(key("c", "ctrl"), "windows")).toBe("copy");
    expect(explorerClipboardAction(key("v", "ctrl"), "linux")).toBe("paste");
    expect(explorerClipboardAction(key("c", "ctrl"), "mac")).toBeNull();
    expect(explorerClipboardAction(key("v", "meta"), "windows")).toBeNull();
    expect(explorerClipboardAction(key("c"), "linux")).toBeNull();
    expect(explorerClipboardAction(key("v", "ctrl", { shiftKey: true }), "windows")).toBeNull();
    expect(explorerClipboardAction(key("c", "meta", { altKey: true }), "mac")).toBeNull();
    expect(explorerClipboardAction(key("x", "meta"), "mac")).toBeNull();
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

  it("uses Ctrl for the chord on Linux, as on Windows", () => {
    const pending = advanceOpenFolderChord(null, key("k", "ctrl"), "linux", 100);
    expect(pending.action).toBe("pending");
    expect(advanceOpenFolderChord(pending.state, key("o", "ctrl"), "linux", 400).action).toBe("open");
    expect(advanceOpenFolderChord(null, key("k", "meta"), "linux", 100).action).toBe("none");
  });

  it("does not consume editor-handled, mismatched, or expired chords", () => {
    expect(advanceOpenFolderChord(null, key("k", "ctrl", { defaultPrevented: true }), "windows", 100).consume).toBe(
      false,
    );

    const pending = advanceOpenFolderChord(null, key("k", "meta"), "mac", 100);
    expect(advanceOpenFolderChord(pending.state, key("o", "ctrl"), "mac", 200).action).toBe("none");
    expect(advanceOpenFolderChord(pending.state, key("o", "meta"), "mac", 1_301).action).toBe("none");
  });
});
