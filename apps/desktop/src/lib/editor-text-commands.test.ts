import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { changeCase, finalNewlineChange, saveFormattingChanges, sortLines, trailingWhitespaceChanges } from "./editor-text-commands";

const apply = (state: EditorState, spec: ReturnType<typeof sortLines>) => spec ? state.update(spec).state.doc.toString() : state.doc.toString();

describe("editor text commands", () => {
  it("sorts the whole document when nothing is selected, with natural number order", () => {
    const state = EditorState.create({ doc: "item10\nitem2\nItem1" });
    expect(apply(state, sortLines(state, false))).toBe("Item1\nitem2\nitem10");
    expect(apply(state, sortLines(state, true))).toBe("item10\nitem2\nItem1");
  });

  it("sorts only the selected lines and ignores a line the selection merely touches", () => {
    const doc = "c\nb\na\nz";
    const state = EditorState.create({ doc, selection: EditorSelection.single(0, doc.indexOf("a")) });
    expect(apply(state, sortLines(state, false))).toBe("b\nc\na\nz");
  });

  it("returns nothing when lines are already sorted", () => {
    expect(sortLines(EditorState.create({ doc: "a\nb" }), false)).toBeNull();
  });

  it("changes the case of the selection or of the word at the cursor", () => {
    const selected = EditorState.create({ doc: "hello world", selection: EditorSelection.single(0, 5) });
    expect(apply(selected, changeCase(selected, true))).toBe("HELLO world");
    const cursor = EditorState.create({ doc: "hello WORLD", selection: EditorSelection.cursor(8) });
    expect(apply(cursor, changeCase(cursor, false))).toBe("hello world");
  });

  it("finds trailing spaces and tabs on every line", () => {
    const state = EditorState.create({ doc: "a  \nb\t\n  c" });
    expect(state.update({ changes: trailingWhitespaceChanges(state) }).state.doc.toString()).toBe("a\nb\n  c");
  });

  it("adds a final newline only when the file lacks one", () => {
    expect(finalNewlineChange(EditorState.create({ doc: "a\n" }))).toBeNull();
    expect(finalNewlineChange(EditorState.create({ doc: "" }))).toBeNull();
    expect(finalNewlineChange(EditorState.create({ doc: "a" }))).toEqual({ from: 1, insert: "\n" });
  });

  it("combines the save formatting options", () => {
    const state = EditorState.create({ doc: "a \nb " });
    const changes = saveFormattingChanges(state, { trimTrailingWhitespace: true, insertFinalNewline: true });
    expect(state.update({ changes }).state.doc.toString()).toBe("a\nb\n");
    expect(saveFormattingChanges(state, { trimTrailingWhitespace: false, insertFinalNewline: false })).toEqual([]);
  });
});
