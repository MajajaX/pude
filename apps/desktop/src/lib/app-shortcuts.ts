import { shortcutKey } from "./keyboard-input";

export type ShortcutEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** Shortcuts that also work while a text field has focus. */
export type GlobalShortcut = "commandPalette" | "searchProject" | "openSettings";

/** Shortcuts for the editor area; text fields keep these keys for themselves. */
export type EditorShortcut =
  | "save"
  | "saveAs"
  | "saveAll"
  | "openFile"
  | "closeTab"
  | "find"
  | "replace"
  | "goToLine"
  | "nextTab"
  | "previousTab"
  | "reopenClosedTab"
  | "toggleSidebar"
  | "goToFile"
  | "toggleMarkdownPreview"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom"
  | "toggleWordWrap";

export function globalShortcut(event: ShortcutEvent): GlobalShortcut | undefined {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (event.shiftKey && key === "p") return "commandPalette";
  if (event.shiftKey && key === "f") return "searchProject";
  if (!event.shiftKey && key === ",") return "openSettings";
}

/** Cmd on macOS and Ctrl elsewhere act as the same modifier. */
export function editorShortcut(event: ShortcutEvent, mac: boolean): EditorShortcut | undefined {
  const modifier = event.ctrlKey || event.metaKey;
  if (!modifier) return event.altKey && !event.shiftKey && event.code === "KeyZ" ? "toggleWordWrap" : undefined;
  const key = shortcutKey(event, mac);
  if (event.key === "Tab") return event.shiftKey ? "previousTab" : "nextTab";
  if (key === "s") return event.shiftKey ? "saveAs" : event.altKey ? "saveAll" : "save";
  if (key === "f" && event.altKey) return mac && !event.shiftKey ? "replace" : undefined;
  if (key === "h" && !mac && !event.altKey && !event.shiftKey) return "replace";
  if (event.altKey) return;
  if (event.shiftKey) {
    if (key === "t") return "reopenClosedTab";
    if (key === "v") return "toggleMarkdownPreview";
    if (key === "+") return "zoomIn";
    return;
  }
  const plain: Partial<Record<string, EditorShortcut>> = {
    o: "openFile",
    w: "closeTab",
    f: "find",
    g: "goToLine",
    b: "toggleSidebar",
    p: "goToFile",
    "=": "zoomIn",
    "+": "zoomIn",
    "-": "zoomOut",
    "0": "resetZoom",
  };
  return plain[key];
}
