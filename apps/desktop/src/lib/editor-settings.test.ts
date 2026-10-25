import { describe, expect, it } from "vitest";
import { EDITOR_SETTING_KEYS, pickEditorSettings, sameEditorSettings } from "./editor-settings";
import { defaultSettings } from "./settings";
import type { EditorSettings } from "../components/EditorPane";

const settings: EditorSettings = { theme: "dark", fontSize: 14, tabSize: 2, insertSpaces: true, wordWrap: false, lineNumbers: true, showWhitespace: false, autoCloseBrackets: true };

describe("editor settings equality", () => {
  it("ignores object identity when editor fields are unchanged", () => {
    expect(sameEditorSettings(settings, { ...settings })).toBe(true);
  });

  it("detects every field that changes editor configuration", () => {
    for (const key of EDITOR_SETTING_KEYS) {
      const value = settings[key];
      const changed = typeof value === "boolean" ? !value : typeof value === "number" ? value + 1 : "light";
      expect(sameEditorSettings(settings, { ...settings, [key]: changed })).toBe(false);
    }
  });

  it("picks only the editor fields from application settings", () => {
    expect(Object.keys(pickEditorSettings(defaultSettings)).sort()).toEqual([...EDITOR_SETTING_KEYS].sort());
  });
});
