import { describe, expect, it } from "vitest";
import { editorShortcut, globalShortcut, type ShortcutEvent } from "./app-shortcuts";
import { BUILTIN_COMMANDS } from "./builtin-commands";

/** The keydown a `Mod+Shift+S` style shortcut produces on one platform. */
function keydown(shortcut: string, mac: boolean): ShortcutEvent {
  const parts = shortcut.split("+");
  const key = parts.pop()!;
  const has = (name: string) => parts.includes(name);
  return {
    key:
      has("Shift") && /^[a-z]$/i.test(key)
        ? key.toUpperCase()
        : key.toLowerCase() === "tab"
          ? "Tab"
          : key.toLowerCase(),
    code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : "",
    metaKey: has("Mod") && mac,
    ctrlKey: (has("Mod") && !mac) || has("Ctrl"),
    altKey: has("Alt"),
    shiftKey: has("Shift"),
  };
}

// Commands whose keys belong to the editor itself or the terminal panel are not app shortcuts.
const handledElsewhere = (id: string) => id.startsWith("pude.builtin.editor.") || id === "pude.builtin.toggleTerminal";

const expected: Record<string, string> = {
  "pude.builtin.openFile": "openFile",
  "pude.builtin.save": "save",
  "pude.builtin.saveAs": "saveAs",
  "pude.builtin.saveAll": "saveAll",
  "pude.builtin.closeEditor": "closeTab",
  "pude.builtin.reopenClosedTab": "reopenClosedTab",
  "pude.builtin.goToFile": "goToFile",
  "pude.builtin.goToLine": "goToLine",
  "pude.builtin.find": "find",
  "pude.builtin.replace": "replace",
  "pude.builtin.searchProject": "searchProject",
  "pude.builtin.toggleSidebar": "toggleSidebar",
  "pude.builtin.toggleWordWrap": "toggleWordWrap",
  "pude.builtin.zoomIn": "zoomIn",
  "pude.builtin.zoomOut": "zoomOut",
  "pude.builtin.resetZoom": "resetZoom",
  "pude.builtin.toggleMarkdownPreview": "toggleMarkdownPreview",
  "pude.builtin.openSettings": "openSettings",
};

describe("app shortcuts", () => {
  for (const mac of [true, false]) {
    it(`run the command each palette shortcut shows on ${mac ? "macOS" : "Windows and Linux"}`, () => {
      for (const command of BUILTIN_COMMANDS) {
        const shortcut = (mac && command.macShortcut) || command.shortcut;
        if (!shortcut || handledElsewhere(command.id)) continue;
        const event = keydown(shortcut, mac);
        expect(globalShortcut(event) ?? editorShortcut(event, mac), `${command.id} ${shortcut}`).toBe(
          expected[command.id],
        );
      }
    });
  }

  it("leaves Shift variants of single-key shortcuts alone", () => {
    expect(editorShortcut(keydown("Mod+Shift+W", false), false)).toBeUndefined();
    expect(editorShortcut(keydown("Mod+Shift+G", true), true)).toBeUndefined();
  });

  it("cycles tabs with Ctrl+Tab and Ctrl+Shift+Tab", () => {
    expect(editorShortcut(keydown("Ctrl+Tab", true), true)).toBe("nextTab");
    expect(editorShortcut(keydown("Ctrl+Shift+Tab", true), true)).toBe("previousTab");
  });
});
