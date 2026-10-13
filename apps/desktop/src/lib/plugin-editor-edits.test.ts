import { describe, expect, it } from "vitest";
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { createPluginEditorEditTransaction } from "./plugin-editor-edits";

describe("createPluginEditorEditTransaction", () => {
  it("builds an undoable transaction when the document revision matches", () => {
    const state = EditorState.create({ doc: "hello", extensions: [history()] });
    const transaction = createPluginEditorEditTransaction(state, 3, 3, [{ from: 0, to: 5, insert: "HELLO" }]);
    expect(transaction).toBeDefined();
    if (!transaction) return;

    const edited = transaction.state;
    expect(edited.doc.toString()).toBe("HELLO");
    let undone = edited;
    expect(undo({ state: edited, dispatch: (next) => { undone = next.state; } })).toBe(true);
    expect(undone.doc.toString()).toBe("hello");
  });

  it("rejects stale revisions, out-of-range offsets, and overlapping edits", () => {
    const state = EditorState.create({ doc: "hello" });
    expect(createPluginEditorEditTransaction(state, 2, 3, [{ from: 0, to: 1, insert: "H" }])).toBeUndefined();
    expect(createPluginEditorEditTransaction(state, 3, 3, [{ from: 0, to: 99, insert: "H" }])).toBeUndefined();
    expect(createPluginEditorEditTransaction(state, 3, 3, [
      { from: 0, to: 3, insert: "H" },
      { from: 2, to: 4, insert: "L" },
    ])).toBeUndefined();
  });
});
