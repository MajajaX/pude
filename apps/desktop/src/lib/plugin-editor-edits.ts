import type { EditorState, Transaction } from "@codemirror/state";
import { normalizeDocumentContent } from "./file-metadata";

export type PluginEditorEdit = {
  from: number;
  to: number;
  insert: string;
};

/** Build a CodeMirror transaction only when edits target the current document revision. */
export function createPluginEditorEditTransaction(
  state: EditorState,
  expectedRevision: number,
  currentRevision: number,
  edits: readonly PluginEditorEdit[],
): Transaction | undefined {
  if (expectedRevision !== currentRevision) return undefined;
  let previousEnd = -1;
  for (const edit of edits) {
    if (!Number.isSafeInteger(edit.from)
        || !Number.isSafeInteger(edit.to)
        || edit.from < 0
        || edit.from < previousEnd
        || edit.to < edit.from
        || edit.to > state.doc.length
        || typeof edit.insert !== "string") {
      return undefined;
    }
    previousEnd = edit.to;
  }
  // Editor documents always store LF-normalized text; plugin inserts must
  // not introduce raw carriage returns or the line-ending map would no
  // longer describe every separator in the document.
  return state.update({ changes: edits.map((edit) => ({ from: edit.from, to: edit.to, insert: normalizeDocumentContent(edit.insert) })) });
}
