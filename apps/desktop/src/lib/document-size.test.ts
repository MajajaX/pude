import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  LARGE_FILE_ENTER_BYTES,
  LARGE_FILE_EXIT_BYTES,
  largeFileModeForSize,
  serializedDocumentByteLength,
  updateUtf8ByteLength,
  utf8ByteLength,
} from "./document-size";

const encodedLength = (value: string) => new TextEncoder().encode(value).length;

describe("incremental serialized document size", () => {
  it.each([
    ["ASCII", "ascii text"],
    ["CJK", "編輯器文件大小"],
    ["emoji", "pude 😀 🧪"],
    ["unpaired surrogate", "before\ud83d after"],
  ])("matches UTF-8 encoding for %s", (_label, value) => {
    expect(utf8ByteLength(value)).toBe(encodedLength(value));
  });

  it.each([
    { value: "A你好😀Z", from: 1, to: 3, insert: "語" },
    // The edit splits a surrogate pair. TextEncoder counts the remaining lone
    // surrogate as U+FFFD, so boundary context must be included in the delta.
    { value: "A😀Z", from: 2, to: 2, insert: "x" },
    { value: "A😀Z", from: 1, to: 3, insert: "語😀" },
    { value: "A\n你好\n😀Z", from: 2, to: 4, insert: "🧪\n" },
  ])("updates only the changed UTF-8 spans for $value", ({ value, from, to, insert }) => {
    const before = EditorState.create({ doc: value });
    const update = before.update({ changes: { from, to, insert } });
    const measured = utf8ByteLength(before.doc.toString())
      + updateUtf8ByteLength(before.doc, update.state.doc, update.changes);
    expect(measured).toBe(encodedLength(update.state.doc.toString()));
  });

  it("merges nearby changed ranges when several edits share surrogate context", () => {
    const before = EditorState.create({ doc: "a😀bc你好😀z" });
    const update = before.update({ changes: [
      { from: 2, to: 3, insert: "x" },
      { from: 7, to: 8, insert: "語" },
    ] });
    const measured = utf8ByteLength(before.doc.toString())
      + updateUtf8ByteLength(before.doc, update.state.doc, update.changes);
    expect(measured).toBe(encodedLength(update.state.doc.toString()));
  });

  it("adds CRLF and BOM serialization overhead and uses threshold hysteresis", () => {
    expect(serializedDocumentByteLength(12, 2, true)).toBe(17);
    expect(largeFileModeForSize(false, LARGE_FILE_ENTER_BYTES)).toBe(false);
    expect(largeFileModeForSize(false, LARGE_FILE_ENTER_BYTES + 1)).toBe(true);
    expect(largeFileModeForSize(true, LARGE_FILE_EXIT_BYTES)).toBe(true);
    expect(largeFileModeForSize(true, LARGE_FILE_EXIT_BYTES - 1)).toBe(false);
    expect(largeFileModeForSize(true, LARGE_FILE_ENTER_BYTES - 1)).toBe(true);
    expect(largeFileModeForSize(false, LARGE_FILE_EXIT_BYTES + 1)).toBe(false);
  });
});
