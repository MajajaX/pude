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

function shortcutModifier(event: ShortcutKeyEvent, platform: ExplorerPlatform): "ctrl" | "meta" | null {
  if (platform === "windows" && event.ctrlKey && !event.metaKey) return "ctrl";
  if (platform === "mac" && event.metaKey && !event.ctrlKey) return "meta";
  return null;
}

export function normalizeExplorerPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

function explorerPathKey(path: string): string {
  const normalized = normalizeExplorerPath(path);
  const windowsPath = path.includes("\\") || normalized.startsWith("//") || /^[A-Za-z]:\//.test(normalized);
  return windowsPath ? normalized.toLowerCase() : normalized;
}

/** Return the workspace-relative path, or null when the item is outside it. */
export function relativePathWithinRoot(path: string, root: string): string | null {
  const candidateKey = explorerPathKey(path);
  const rootKey = explorerPathKey(root);
  const isFilesystemRoot = rootKey === "/" || /^[A-Za-z]:\/$/.test(rootKey);
  const inside = candidateKey === rootKey || (isFilesystemRoot ? candidateKey.startsWith(rootKey) : candidateKey.startsWith(`${rootKey}/`));
  if (!inside) return null;

  const candidate = normalizeExplorerPath(path);
  const rootPath = normalizeExplorerPath(root);
  if (candidateKey === rootKey) return ".";
  return candidate.slice(rootPath.length).replace(/^\/+/, "") || ".";
}
