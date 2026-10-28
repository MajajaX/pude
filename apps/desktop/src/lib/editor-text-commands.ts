import { copyLineDown, deleteLine, selectParentSyntax, toggleComment } from "@codemirror/commands";
import { foldAll, unfoldAll } from "@codemirror/language";
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { EditorSelection, type ChangeSpec, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type EditorCommandName =
  | "sortLinesAscending"
  | "sortLinesDescending"
  | "upperCase"
  | "lowerCase"
  | "trimTrailingWhitespace"
  | "toggleComment"
  | "duplicateLine"
  | "deleteLine"
  | "selectAllOccurrences"
  | "addNextOccurrence"
  | "expandSelection"
  | "foldAll"
  | "unfoldAll";

export type EditorCommandRequest = { command: EditorCommandName; tabId: string; actionId: number };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Lines touched by the selection, or the whole document when nothing is selected. */
function selectedLineRange(state: EditorState): { from: number; to: number } {
  const { from, to } = state.selection.main;
  if (from === to) return { from: 0, to: state.doc.length };
  const first = state.doc.lineAt(from);
  // A selection that ends at the start of a line does not include that line.
  const last = state.doc.lineAt(to > from && state.doc.lineAt(to).from === to ? to - 1 : to);
  return { from: first.from, to: last.to };
}

export function sortLines(state: EditorState, descending: boolean): TransactionSpec | null {
  const range = selectedLineRange(state);
  const lines = state.sliceDoc(range.from, range.to).split("\n");
  if (lines.length < 2) return null;
  const sorted = [...lines].sort((left, right) => descending ? collator.compare(right, left) : collator.compare(left, right));
  const insert = sorted.join("\n");
  if (insert === lines.join("\n")) return null;
  return { changes: { from: range.from, to: range.to, insert }, selection: EditorSelection.range(range.from, range.from + insert.length), userEvent: "input.sort" };
}

/** Change the case of each selection, or of the word at an empty cursor. */
export function changeCase(state: EditorState, upper: boolean): TransactionSpec | null {
  const changes: ChangeSpec[] = [];
  for (const range of state.selection.ranges) {
    const target = range.empty ? state.wordAt(range.head) : range;
    if (!target) continue;
    const text = state.sliceDoc(target.from, target.to);
    const insert = upper ? text.toLocaleUpperCase() : text.toLocaleLowerCase();
    if (insert !== text && insert.length === text.length) changes.push({ from: target.from, to: target.to, insert });
  }
  return changes.length ? { changes, userEvent: "input.case" } : null;
}

export function trailingWhitespaceChanges(state: EditorState): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number);
    const trimmed = line.text.replace(/[ \t]+$/, "");
    if (trimmed.length !== line.text.length) changes.push({ from: line.from + trimmed.length, to: line.to });
  }
  return changes;
}

export function finalNewlineChange(state: EditorState): ChangeSpec | null {
  const length = state.doc.length;
  if (length === 0 || state.sliceDoc(length - 1) === "\n") return null;
  return { from: length, insert: "\n" };
}

/** Edits applied before a save; empty when the document already matches the options. */
export function saveFormattingChanges(state: EditorState, options: { trimTrailingWhitespace: boolean; insertFinalNewline: boolean }): ChangeSpec[] {
  const changes = options.trimTrailingWhitespace ? trailingWhitespaceChanges(state) : [];
  const newline = options.insertFinalNewline ? finalNewlineChange(state) : null;
  return newline ? [...changes, newline] : changes;
}

const runSpec = (view: EditorView, spec: TransactionSpec | null): boolean => {
  if (!spec) return false;
  view.dispatch(spec);
  return true;
};

export function runEditorCommand(view: EditorView, command: EditorCommandName): boolean {
  switch (command) {
    case "sortLinesAscending": return runSpec(view, sortLines(view.state, false));
    case "sortLinesDescending": return runSpec(view, sortLines(view.state, true));
    case "upperCase": return runSpec(view, changeCase(view.state, true));
    case "lowerCase": return runSpec(view, changeCase(view.state, false));
    case "trimTrailingWhitespace": {
      const changes = trailingWhitespaceChanges(view.state);
      return runSpec(view, changes.length ? { changes, userEvent: "delete.trailing" } : null);
    }
    case "toggleComment": return toggleComment(view);
    case "duplicateLine": return copyLineDown(view);
    case "deleteLine": return deleteLine(view);
    case "selectAllOccurrences": return selectSelectionMatches(view);
    case "addNextOccurrence": return selectNextOccurrence(view);
    case "expandSelection": return selectParentSyntax(view);
    case "foldAll": return foldAll(view);
    case "unfoldAll": return unfoldAll(view);
  }
}
