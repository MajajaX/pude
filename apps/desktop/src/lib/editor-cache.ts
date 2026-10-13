import { historyField } from "@codemirror/commands";
import type { EditorState } from "@codemirror/state";

export {
  EDITOR_CACHE_MAX_BYTES,
  EDITOR_CACHE_MAX_STATES,
  changedEditorSettings,
  estimateEditorDocumentCacheBytes,
  exceedsEditorStateBudget,
  leastRecentlyUsedEditor,
  leastRecentlyUsedReleasableDocument,
  lineEndingMapStorageBytes,
} from "./editor-cache-budget";
export type {
  CachedTextFootprint,
  EditorCacheEntry,
  EditorDocumentCacheStatus,
  EditorDocumentEvictionState,
  EditorDocumentFootprint,
  EditorSettingsChange,
  EditorSettingsSnapshot,
  ReleasableEditorDocument,
} from "./editor-cache-budget";

type HistoryFieldInternals = {
  spec?: {
    toJSON?: (value: unknown, state: EditorState) => unknown;
  };
};

/**
 * Serialize only the history field value; EditorState.toJSON would also copy
 * the full document. If CodeMirror ever removes the field serializer, callers
 * must keep the original state attached rather than dropping undo history.
 */
export function serializeEditorHistory(state: EditorState): unknown | undefined {
  const value = state.field(historyField, false);
  const serializer = (historyField as unknown as HistoryFieldInternals).spec?.toJSON;
  if (value === undefined || !serializer) return undefined;
  try {
    return serializer(value, state);
  } catch {
    return undefined;
  }
}

/** Read Undo/Redo presence without serializing CodeMirror's history field. */
export function hasEditorUndoHistory(
  state?: EditorState,
  serializedHistory?: unknown,
  additionalHistoryEntries = 0,
): boolean {
  if (additionalHistoryEntries > 0) return true;
  if (state) {
    const value = state.field(historyField, false) as { done?: readonly unknown[]; undone?: readonly unknown[] } | undefined;
    if ((value?.done?.length ?? 0) + (value?.undone?.length ?? 0) > 0) return true;
  }
  if (!serializedHistory || typeof serializedHistory !== "object") return false;
  const value = serializedHistory as { done?: unknown[]; undone?: unknown[] };
  return (Array.isArray(value.done) ? value.done.length : 0)
    + (Array.isArray(value.undone) ? value.undone.length : 0) > 0;
}
