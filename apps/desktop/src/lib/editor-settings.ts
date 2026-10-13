import type { EditorSettings } from "../components/EditorPane";

export function sameEditorSettings(left: EditorSettings, right: EditorSettings): boolean {
  return left.theme === right.theme
    && left.fontSize === right.fontSize
    && left.tabSize === right.tabSize
    && left.insertSpaces === right.insertSpaces
    && left.wordWrap === right.wordWrap;
}
