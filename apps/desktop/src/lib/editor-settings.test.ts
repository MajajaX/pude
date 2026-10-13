import { describe, expect, it } from "vitest";
import { sameEditorSettings } from "./editor-settings";
import type { EditorSettings } from "../components/EditorPane";

const settings: EditorSettings = { theme: "dark", fontSize: 14, tabSize: 2, insertSpaces: true, wordWrap: false };

describe("editor settings equality", () => {
  it("ignores object identity when editor fields are unchanged", () => {
    expect(sameEditorSettings(settings, { ...settings })).toBe(true);
  });

  it("detects every field that changes editor configuration", () => {
    for (const key of ["theme", "fontSize", "tabSize", "insertSpaces", "wordWrap"] as const) {
      const next = { ...settings };
      if (key === "theme") next.theme = "light";
      if (key === "fontSize") next.fontSize += 1;
      if (key === "tabSize") next.tabSize += 1;
      if (key === "insertSpaces") next.insertSpaces = !next.insertSpaces;
      if (key === "wordWrap") next.wordWrap = !next.wordWrap;
      expect(sameEditorSettings(settings, next)).toBe(false);
    }
  });
});
