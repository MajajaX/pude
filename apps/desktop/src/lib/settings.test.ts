import { describe, expect, it } from "vitest";
import { clampSetting, parseWatcherExcludes, validateSettings } from "./settings";
import { defaultSettings } from "./demo";

describe("settings validation", () => {
  it("clamps numeric input to the supported range", () => {
    expect(clampSetting("fontSize", -2, 14)).toBe(11);
    expect(clampSetting("tabSize", "99", 2)).toBe(8);
    expect(clampSetting("tabSize", "not-a-number", 2)).toBe(2);
    expect(clampSetting("terminalHeight", 40, 238)).toBe(160);
    expect(clampSetting("terminalHeight", 900.4, 238)).toBe(900);
    expect(clampSetting("terminalHeight", 5000, 238)).toBe(1200);
  });

  it("rejects invalid stored values while preserving valid settings", () => {
    expect(validateSettings({ theme: "unknown", fontSize: -4, tabSize: 99, wordWrap: true }, defaultSettings)).toMatchObject({
      theme: "dark",
      fontSize: 11,
      tabSize: 8,
      wordWrap: true,
      sidebarWidth: 276,
      watcherExcludes: [],
      groupGitIgnoredFiles: true,
    });
  });

  it("normalizes watcher excludes from stored and editable values", () => {
    expect(parseWatcherExcludes(" node_modules, dist\n.cache, node_modules ")).toEqual(["node_modules", "dist", ".cache"]);
    expect(validateSettings({ watcherExcludes: ["dist", "", 4, "dist", "x".repeat(513)] }, defaultSettings).watcherExcludes).toEqual(["dist"]);
  });

  it("preserves the ignored grouping preference and migrates older settings", () => {
    expect(validateSettings({ groupGitIgnoredFiles: false }, defaultSettings).groupGitIgnoredFiles).toBe(false);
    expect(validateSettings({ groupGitIgnoredFiles: "false" }, defaultSettings).groupGitIgnoredFiles).toBe(true);
    expect(validateSettings({}, defaultSettings).groupGitIgnoredFiles).toBe(true);
  });
});
