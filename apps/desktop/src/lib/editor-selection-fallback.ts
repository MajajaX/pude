import type { EditorSelectionFallback, EditorTab } from "../types";

/** Selection fallbacks are memory-only and deliberately small. Larger
 * multi-selections stay in the retained editor document instead of being
 * truncated during a cache eviction. */
export const EDITOR_SELECTION_FALLBACK_MAX_RANGES = 64;

export function createEditorSelectionFallback(
  value: unknown,
  revision: number,
  contentVersion: number,
  textLength: number,
): EditorSelectionFallback | undefined {
  if (!Number.isSafeInteger(revision) || revision < 0
    || !Number.isSafeInteger(contentVersion) || contentVersion < 0
    || !Number.isSafeInteger(textLength) || textLength < 0
    || !value || typeof value !== "object") return undefined;

  const selection = value as { main?: unknown; mainIndex?: unknown; ranges?: unknown };
  if (!Array.isArray(selection.ranges)
    || selection.ranges.length === 0
    || selection.ranges.length > EDITOR_SELECTION_FALLBACK_MAX_RANGES) return undefined;

  const main = selection.main ?? selection.mainIndex;
  if (!Number.isSafeInteger(main) || (main as number) < 0 || (main as number) >= selection.ranges.length) return undefined;

  const ranges: Array<{ anchor: number; head: number }> = [];
  for (const value of selection.ranges) {
    if (!value || typeof value !== "object") return undefined;
    const range = value as { anchor?: unknown; head?: unknown };
    if (!Number.isSafeInteger(range.anchor) || !Number.isSafeInteger(range.head)
      || (range.anchor as number) < 0 || (range.anchor as number) > textLength
      || (range.head as number) < 0 || (range.head as number) > textLength) return undefined;
    ranges.push({ anchor: range.anchor as number, head: range.head as number });
  }

  return { revision, contentVersion, selection: { main: main as number, ranges } };
}

export function currentEditorSelectionFallback(
  fallback: EditorSelectionFallback | undefined,
  revision: number,
  contentVersion: number,
  textLength: number,
): EditorSelectionFallback["selection"] | undefined {
  if (!fallback || fallback.revision !== revision || fallback.contentVersion !== contentVersion) return undefined;
  return createEditorSelectionFallback(fallback.selection, revision, contentVersion, textLength)?.selection;
}

export function editorSelectionFallbackAfterUpdate(
  current: EditorTab,
  changes: Partial<EditorTab>,
): EditorSelectionFallback | undefined {
  const hasSelectionUpdate = Object.prototype.hasOwnProperty.call(changes, "selectionFallback")
    && changes.selectionFallback !== current.selectionFallback;
  const fallback = hasSelectionUpdate ? changes.selectionFallback : current.selectionFallback;
  if (!fallback) return undefined;

  const revision = changes.revision ?? current.revision;
  const contentVersion = changes.contentVersion ?? current.contentVersion;
  const contentChanged = Object.prototype.hasOwnProperty.call(changes, "content") && changes.content !== current.content;
  const cursorChanged = (Object.prototype.hasOwnProperty.call(changes, "cursorLine") && changes.cursorLine !== current.cursorLine)
    || (Object.prototype.hasOwnProperty.call(changes, "cursorColumn") && changes.cursorColumn !== current.cursorColumn);
  if (fallback.revision !== revision || fallback.contentVersion !== contentVersion
    || (contentChanged && !hasSelectionUpdate)
    || (cursorChanged && !hasSelectionUpdate)) return undefined;
  return fallback;
}
