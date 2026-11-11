export type ExplorerPlatform = "mac" | "windows" | "linux";

export type OpenFolderChordState = {
  startedAt: number;
  modifier: "ctrl" | "meta";
} | null;

export type ShortcutKeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented?: boolean;
};

export type OpenFolderChordResult = {
  state: OpenFolderChordState;
  action: "none" | "pending" | "open";
  consume: boolean;
};

export const OPEN_FOLDER_CHORD_TIMEOUT_MS = 1_200;

/**
 * Advance the two-key Open Folder shortcut without guessing when a normal
 * Ctrl/Cmd+O should open a file. The caller consumes only the chord keys.
 */
export function advanceOpenFolderChord(
  state: OpenFolderChordState,
  event: ShortcutKeyEvent,
  platform: ExplorerPlatform,
  now = Date.now(),
): OpenFolderChordResult {
  if (event.defaultPrevented) return { state: null, action: "none", consume: false };

  const currentModifier = shortcutModifier(event, platform);
  const pending = state && now - state.startedAt <= OPEN_FOLDER_CHORD_TIMEOUT_MS ? state : null;
  if (pending) {
    if (event.key.toLowerCase() === "o" && currentModifier === pending.modifier && !event.altKey && !event.shiftKey) {
      return { state: null, action: "open", consume: true };
    }
    if (event.key.toLowerCase() === "k" && currentModifier === pending.modifier && !event.altKey && !event.shiftKey) {
      return { state: { startedAt: now, modifier: pending.modifier }, action: "pending", consume: true };
    }
    if (event.key.toLowerCase() !== "o" || currentModifier !== pending.modifier) {
      return { state: null, action: "none", consume: false };
    }
  }

  if (event.key.toLowerCase() === "k" && currentModifier && !event.altKey && !event.shiftKey) {
    return { state: { startedAt: now, modifier: currentModifier }, action: "pending", consume: true };
  }
  return { state: null, action: "none", consume: false };
}

/** Cmd on macOS, Ctrl on Windows and Linux. */
function shortcutModifier(event: ShortcutKeyEvent, platform: ExplorerPlatform): "ctrl" | "meta" | null {
  if (platform === "mac") return event.metaKey && !event.ctrlKey ? "meta" : null;
  return event.ctrlKey && !event.metaKey ? "ctrl" : null;
}

export function explorerClipboardAction(event: ShortcutKeyEvent, platform: ExplorerPlatform): "copy" | "paste" | null {
  const primaryModifier = platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primaryModifier || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  return key === "c" ? "copy" : key === "v" ? "paste" : null;
}
