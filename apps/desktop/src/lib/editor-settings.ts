import type { EditorSettings } from "../components/EditorPane";
import type { AppSettings } from "../types";

export const EDITOR_SETTING_KEYS = ["theme", "fontSize", "tabSize", "insertSpaces", "wordWrap", "lineNumbers", "showWhitespace", "autoCloseBrackets"] as const satisfies readonly (keyof AppSettings)[];

export function pickEditorSettings(settings: AppSettings): EditorSettings {
  return Object.fromEntries(EDITOR_SETTING_KEYS.map((key) => [key, settings[key]])) as EditorSettings;
}

export function sameEditorSettings(left: EditorSettings, right: EditorSettings): boolean {
  return EDITOR_SETTING_KEYS.every((key) => left[key] === right[key]);
}
