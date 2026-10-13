import { describe, expect, it } from "vitest";
import { history, historyField, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { changedEditorSettings, estimateEditorDocumentCacheBytes, exceedsEditorStateBudget, hasEditorUndoHistory, leastRecentlyUsedEditor, leastRecentlyUsedReleasableDocument, serializeEditorHistory } from "./editor-cache";
import { lineEndingMapFromString, lineEndingMapSlice, lineEndingMapStorageBytes } from "./line-ending-state";

const settings = {
  theme: "dark" as const,
  fontSize: 14,
  tabSize: 2,
  insertSpaces: true,
  wordWrap: false,
};

describe("editor cache decisions", () => {
  it("reports only settings whose compartments need reconfiguration", () => {
    expect(changedEditorSettings(settings, { ...settings, sidebarWidth: 320 } as typeof settings & { sidebarWidth: number })).toEqual([]);
    expect(changedEditorSettings(settings, { ...settings, wordWrap: true })).toEqual(["wordWrap"]);
    expect(changedEditorSettings(settings, { ...settings, fontSize: 16 })).toEqual(["fontSize"]);
  });

  it("chooses the least recently used non-active full state", () => {
    const candidate = leastRecentlyUsedEditor([
      { id: "active", lastUsed: 1, stateBytes: 100, hasState: true },
      { id: "old", lastUsed: 2, stateBytes: 100, hasState: true },
      { id: "new", lastUsed: 3, stateBytes: 100, hasState: true },
      { id: "detached", lastUsed: 0, stateBytes: 100, hasState: false },
    ], "active");
    expect(candidate?.id).toBe("old");
  });

  it("chooses clean, history-free retained documents before protected cache entries", () => {
    const candidate = leastRecentlyUsedReleasableDocument([
      { id: "dirty", state: { lastUsed: 1, dirty: true, hasUndoHistory: false, canRelease: false } },
      { id: "undo", state: { lastUsed: 2, dirty: false, hasUndoHistory: true, canRelease: false } },
      { id: "newer-clean", state: { lastUsed: 5, dirty: false, hasUndoHistory: false, canRelease: true } },
      { id: "oldest-clean", state: { lastUsed: 3, dirty: false, hasUndoHistory: false, canRelease: true } },
    ]);
    expect(candidate?.id).toBe("oldest-clean");
  });

  it("treats the state budget as an eviction trigger without implying a heap limit", () => {
    expect(exceedsEditorStateBudget(25, 1, 24, 32 * 1024 * 1024)).toBe(true);
    expect(exceedsEditorStateBudget(24, 32 * 1024 * 1024, 24, 32 * 1024 * 1024)).toBe(false);
  });

  it("counts attached and detached text, baselines, history, and shared maps once", () => {
    const sharedText = {};
    const changedText = {};
    const map = lineEndingMapFromString("cl".repeat(1200));
    const sharedMapSlice = lineEndingMapSlice(map, 0, 1024);
    const maps = [map, sharedMapSlice];
    const mapBytes = lineEndingMapStorageBytes(maps);

    const bytes = estimateEditorDocumentCacheBytes([
      {
        texts: [{ identity: sharedText, codeUnits: 10 }, { identity: sharedText, codeUnits: 10 }],
        lineEndingMaps: maps,
        serializedHistoryBytes: 400,
        lineEndingHistoryEntries: 3,
        selectionBytes: 40,
        hasState: true,
      },
      {
        texts: [{ identity: changedText, codeUnits: 7 }, { identity: sharedText, codeUnits: 10 }],
        lineEndingMaps: [map],
        serializedHistoryBytes: 200,
        lineEndingHistoryEntries: 2,
        selectionBytes: 0,
        hasState: false,
      },
    ]);

    expect(bytes).toBe(
      20 + 14 + mapBytes
      + 400 + 3 * 48 + 40 + 1024 + 2048
      + 200 + 2 * 48 + 1024,
    );
  });

  it("keeps large Undo history estimates above the old fixed cap", () => {
    const historyBytes = 6 * 1024 * 1024;
    const bytes = estimateEditorDocumentCacheBytes([{
      texts: [],
      lineEndingMaps: [],
      serializedHistoryBytes: historyBytes,
      lineEndingHistoryEntries: 1000,
      selectionBytes: 32,
      hasState: false,
    }]);
    expect(bytes).toBeGreaterThan(historyBytes);
    expect(bytes).toBe(historyBytes + 1000 * 48 + 32 + 1024);
  });

  it("round trips the history field without serializing the document", () => {
    let state = EditorState.create({ doc: "before", extensions: history() });
    state = state.update({ changes: { from: 0, to: 6, insert: "after" } }).state;
    const serialized = serializeEditorHistory(state);
    expect(serialized).toEqual(expect.objectContaining({ done: expect.any(Array), undone: expect.any(Array) }));
    expect(Object.keys(serialized as object)).not.toContain("doc");

    const restored = EditorState.fromJSON({ doc: state.doc.toString(), selection: state.selection.toJSON(), history: serialized }, { extensions: history() }, { history: historyField });
    let undone: EditorState | undefined;
    expect(undo({ state: restored, dispatch: (transaction) => { undone = transaction.state; } })).toBe(true);
    expect(undone?.doc.toString()).toBe("before");
  });

  it("protects actual CodeMirror Undo, Redo, and selection-only history entries", () => {
    let state = EditorState.create({ doc: "before", extensions: history() });
    expect(hasEditorUndoHistory(state)).toBe(false);

    state = state.update({ changes: { from: 0, to: 6, insert: "after" }, userEvent: "input.type" }).state;
    expect(hasEditorUndoHistory(state)).toBe(true);
    const serialized = serializeEditorHistory(state);
    expect(hasEditorUndoHistory(undefined, serialized)).toBe(true);

    const restored = EditorState.fromJSON({ doc: state.doc.toString(), selection: state.selection.toJSON(), history: serialized }, { extensions: history() }, { history: historyField });
    let undone: EditorState | undefined;
    undo({ state: restored, dispatch: (transaction) => { undone = transaction.state; } });
    expect(hasEditorUndoHistory(undone)).toBe(true);
    expect(undone?.doc.toString()).toBe("before");

    let selectionState = EditorState.create({ doc: "cursor", extensions: history() });
    selectionState = selectionState.update({ selection: { anchor: 2 }, userEvent: "select.pointer" }).state;
    expect(hasEditorUndoHistory(selectionState)).toBe(true);
    expect(hasEditorUndoHistory(undefined, { done: [], undone: [] })).toBe(false);
  });
});
