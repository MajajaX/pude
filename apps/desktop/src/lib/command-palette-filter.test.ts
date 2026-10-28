import { describe, expect, it } from "vitest";
import { formatShortcut, matchesAllWords, orderByRecent, rememberRecentCommand } from "./command-palette-filter";
import type { CommandPaletteItem } from "./plugin-activation";

const command = (id: string): CommandPaletteItem => ({ id, title: id, source: "builtin" });

describe("command palette filtering", () => {
  it("matches every query word in any order, ignoring case", () => {
    expect(matchesAllWords("View: Toggle Word Wrap", "wrap toggle")).toBe(true);
    expect(matchesAllWords("View: Toggle Word Wrap", "  WRAP  ")).toBe(true);
    expect(matchesAllWords("View: Toggle Word Wrap", "wrap sidebar")).toBe(false);
  });

  it("puts recently run commands first and keeps the rest in order", () => {
    const ordered = orderByRecent([command("a"), command("b"), command("c"), command("d")], ["c", "a"]);
    expect(ordered.map((item) => item.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("remembers a bounded, unique list of recent commands", () => {
    expect(rememberRecentCommand(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(rememberRecentCommand(["1", "2", "3", "4", "5", "6", "7", "8"], "9")).toHaveLength(8);
  });

  it("formats shortcuts for each platform", () => {
    expect(formatShortcut("Mod+Shift+P", true)).toBe("⌘⇧P");
    expect(formatShortcut("Mod+Shift+P", false)).toBe("Ctrl+Shift+P");
    expect(formatShortcut("Shift+Alt+Down", true)).toBe("⇧⌥↓");
  });
});
