import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { createEditorSelectionFallback, currentEditorSelectionFallback, editorSelectionFallbackAfterUpdate, EDITOR_SELECTION_FALLBACK_MAX_RANGES } from "./editor-selection-fallback";
import type { EditorTab } from "../types";

const baseTab = (selectionFallback?: EditorTab["selectionFallback"]): EditorTab => ({
  id: "tab",
  path: "/file.txt",
  name: "file.txt",
  content: "0123456789",
  savedContent: "0123456789",
  dirty: false,
  lineEnding: "lf",
  encoding: "UTF-8",
  language: "Text",
  cursorLine: 1,
  cursorColumn: 1,
  revision: 12,
  savedRevision: 12,
  contentVersion: 3,
  selectionFallback,
});

describe("editor selection fallback", () => {
  it("round trips the exact multi-range selection through a clean document state", () => {
    const original = {
      main: 1,
      ranges: [
        { anchor: 1, head: 4 },
        { anchor: 8, head: 6 },
      ],
    };
    const fallback = createEditorSelectionFallback(original, 12, 3, 10);
    expect(fallback).toEqual({ revision: 12, contentVersion: 3, selection: original });

    const restoredSelection = currentEditorSelectionFallback(fallback, 12, 3, 10);
    const state = EditorState.fromJSON({ doc: "0123456789", selection: restoredSelection }, {
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    expect(state.selection.toJSON()).toEqual(original);
  });

  it("rejects a fallback from another revision or content version", () => {
    const fallback = createEditorSelectionFallback({ main: 0, ranges: [{ anchor: 2, head: 5 }] }, 12, 3, 10);
    expect(currentEditorSelectionFallback(fallback, 13, 3, 10)).toBeUndefined();
    expect(currentEditorSelectionFallback(fallback, 12, 4, 10)).toBeUndefined();
  });

  it("invalidates stale selection data on edits, replacements, and cursor changes", () => {
    const fallback = createEditorSelectionFallback({ main: 0, ranges: [{ anchor: 2, head: 5 }] }, 12, 3, 10)!;
    const tab = baseTab(fallback);

    expect(editorSelectionFallbackAfterUpdate(tab, { revision: 13 })).toBeUndefined();
    expect(editorSelectionFallbackAfterUpdate(tab, { contentVersion: 4 })).toBeUndefined();
    expect(editorSelectionFallbackAfterUpdate(tab, { content: "new text" })).toBeUndefined();
    expect(editorSelectionFallbackAfterUpdate(tab, { content: "new text", selectionFallback: fallback })).toBeUndefined();
    expect(editorSelectionFallbackAfterUpdate(tab, { cursorLine: 2 })).toBeUndefined();
    expect(editorSelectionFallbackAfterUpdate(tab, { dirty: true })).toBe(fallback);
  });

  it("rejects malformed, out-of-bounds, and oversized selections instead of truncating them", () => {
    expect(createEditorSelectionFallback({ main: 0, ranges: [{ anchor: -1, head: 0 }] }, 1, 1, 10)).toBeUndefined();
    expect(createEditorSelectionFallback({ main: 1, ranges: [{ anchor: 0, head: 0 }] }, 1, 1, 10)).toBeUndefined();

    const oversized = {
      main: 0,
      ranges: Array.from({ length: EDITOR_SELECTION_FALLBACK_MAX_RANGES + 1 }, () => ({ anchor: 1, head: 1 })),
    };
    expect(createEditorSelectionFallback(oversized, 1, 1, 10)).toBeUndefined();
  });
});
