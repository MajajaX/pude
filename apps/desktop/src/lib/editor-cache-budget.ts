import type { LineEndingMap } from "./line-ending-state";

export const EDITOR_CACHE_MAX_STATES = 24;
export const EDITOR_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The global document-cache budget is soft. A detached document is releasable
 * only when it can be rebuilt from the saved tab and has no remaining Undo or
 * Redo entries. Dirty text and editor history are protected even above budget.
 */
export type EditorDocumentEvictionState = {
  lastUsed: number;
  dirty: boolean;
  hasUndoHistory: boolean;
  canRelease: boolean;
};

export type EditorDocumentCacheStatus<TDocument = unknown> = {
  estimatedBytes: number;
  maxBytes: number;
  overBudget: boolean;
  /** Detached document ids removed by this budget pass. */
  evictedTabIds: string[];
  /** Exact current seeds which the owner confirmed before release. */
  evictedDocuments: Array<{ tabId: string; document: TDocument }>;
};

export type ReleasableEditorDocument = {
  id: string;
  state: EditorDocumentEvictionState;
};

/** Choose the oldest clean, history-free retained document first. */
export function leastRecentlyUsedReleasableDocument(
  entries: readonly ReleasableEditorDocument[],
): ReleasableEditorDocument | undefined {
  return entries
    .filter((entry) => entry.state.canRelease && !entry.state.dirty && !entry.state.hasUndoHistory)
    .sort((left, right) => left.state.lastUsed - right.state.lastUsed)[0];
}

export type EditorSettingsSnapshot = {
  theme: "dark" | "light";
  fontSize: number;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
};

export type EditorSettingsChange = keyof EditorSettingsSnapshot;

export function changedEditorSettings(
  previous: EditorSettingsSnapshot | undefined,
  next: EditorSettingsSnapshot,
): EditorSettingsChange[] {
  if (!previous) return ["theme", "fontSize", "tabSize", "insertSpaces", "wordWrap"];

  const changed: EditorSettingsChange[] = [];
  if (previous.theme !== next.theme) changed.push("theme");
  if (previous.fontSize !== next.fontSize) changed.push("fontSize");
  if (previous.tabSize !== next.tabSize) changed.push("tabSize");
  if (previous.insertSpaces !== next.insertSpaces) changed.push("insertSpaces");
  if (previous.wordWrap !== next.wordWrap) changed.push("wordWrap");
  return changed;
}

export type EditorCacheEntry = {
  id: string;
  lastUsed: number;
  stateBytes: number;
  hasState: boolean;
};

export type CachedTextFootprint = {
  identity: object;
  codeUnits: number;
};

export type EditorDocumentFootprint = {
  texts: readonly CachedTextFootprint[];
  lineEndingMaps: readonly LineEndingMap[];
  serializedHistoryBytes: number;
  lineEndingHistoryEntries: number;
  selectionBytes: number;
  hasState: boolean;
};

/** Count persistent line-ending nodes once, without importing editor modules. */
export function lineEndingMapStorageBytes(maps: readonly LineEndingMap[], seen = new Set<LineEndingMap>()): number {
  const pending = [...maps];
  let bytes = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (node.kind === "leaf") bytes += node.value.length * 2 + 32;
    else {
      bytes += 64;
      pending.push(node.left, node.right);
    }
  }
  return bytes;
}

/**
 * Estimate the retained editor-document working set, including active and
 * detached documents. Text and persistent line-ending nodes are counted once
 * by identity so saved baselines and history roots that share storage do not
 * inflate the total.
 */
export function estimateEditorDocumentCacheBytes(documents: readonly EditorDocumentFootprint[]): number {
  const seenTexts = new Set<object>();
  const seenMaps = new Set<LineEndingMap>();
  const maps: LineEndingMap[] = [];
  let bytes = 0;
  let stateCount = 0;

  for (const document of documents) {
    for (const text of document.texts) {
      if (seenTexts.has(text.identity)) continue;
      seenTexts.add(text.identity);
      bytes += text.codeUnits * 2;
    }
    for (const map of document.lineEndingMaps) maps.push(map);
    bytes += document.serializedHistoryBytes
      + document.lineEndingHistoryEntries * 48
      + document.selectionBytes
      + 1024;
    if (document.hasState) stateCount += 1;
  }

  return bytes + lineEndingMapStorageBytes(maps, seenMaps) + stateCount * 2048;
}

/** Pick a full CodeMirror state to detach, excluding the active document. */
export function leastRecentlyUsedEditor(
  entries: readonly EditorCacheEntry[],
  activeId: string,
): EditorCacheEntry | undefined {
  return entries
    .filter((entry) => entry.id !== activeId && entry.hasState)
    .sort((left, right) => left.lastUsed - right.lastUsed)[0];
}

export function exceedsEditorStateBudget(
  stateCount: number,
  stateBytes: number,
  maxStates: number,
  maxBytes: number,
): boolean {
  return stateCount > maxStates || stateBytes > maxBytes;
}
