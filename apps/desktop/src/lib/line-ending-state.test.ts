import { describe, expect, it } from "vitest";
import { history, historyField, isolateHistory, redo, redoSelection, undo, undoSelection } from "@codemirror/commands";
import { EditorState, Text, Transaction, type StateField } from "@codemirror/state";
import {
  computeDocumentDirty,
  createLineEndingMapExtension,
  lineEndingMapOf,
  lineEndingMapFromString,
  lineEndingMapStorageBytes,
  lineEndingMapToString,
  lineEndingMapsEqual,
  majorityLineEnding,
  reconcileLineEndingMapChanges,
  type LineEndingMapState,
} from "./line-ending-state";
import { serializeDocumentBytes } from "./file-metadata";
import { createPluginEditorEditTransaction } from "./plugin-editor-edits";
import { serializeEditorHistory } from "./editor-cache";

function makeState(doc: string, map: string, preferred: "lf" | "crlf" = "lf") {
  const created = createLineEndingMapExtension(map, preferred);
  const state = EditorState.create({ doc, extensions: [created.extension, history()] });
  return { state, field: created.field };
}

function mapOf(state: EditorState, field: StateField<LineEndingMapState>): string {
  return lineEndingMapToString(lineEndingMapOf(state, field).map);
}

function latin1(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}

function dispatch(state: EditorState, ...changes: { from: number; to?: number; insert?: string }[]): EditorState {
  return state.update({ changes: changes.map((change) => ({ from: change.from, to: change.to ?? change.from, insert: change.insert ?? "" })) }).state;
}

function undoOnce(state: EditorState): EditorState {
  let next = state;
  expect(undo({ state, dispatch: (tr) => { next = tr.state; } })).toBe(true);
  return next;
}

function redoOnce(state: EditorState): EditorState {
  let next = state;
  expect(redo({ state, dispatch: (tr) => { next = tr.state; } })).toBe(true);
  return next;
}

function runHistoryCommand(state: EditorState, command: typeof undoSelection | typeof redoSelection): EditorState {
  let next = state;
  expect(command({ state, dispatch: (transaction) => { next = transaction.state; } })).toBe(true);
  return next;
}

describe("transactional line-ending map", () => {
  it("restores mixed separators through undo and redo", () => {
    // Minimal reproduction: deleting the middle line must not lose
    // the CRLF marker, and undo must bring back the exact original map.
    const { state: initial, field } = makeState("alpha\nbeta\ngamma", "lc");
    const deleted = dispatch(initial, { from: 6, to: 11 });
    expect(deleted.doc.toString()).toBe("alpha\ngamma");
    expect(mapOf(deleted, field)).toBe("l");

    const undone = undoOnce(deleted);
    expect(undone.doc.toString()).toBe("alpha\nbeta\ngamma");
    expect(mapOf(undone, field)).toBe("lc");

    const redone = redoOnce(undone);
    expect(redone.doc.toString()).toBe("alpha\ngamma");
    expect(mapOf(redone, field)).toBe("l");
  });

  it("preserves untouched separators across a multi-span transaction", () => {
    // Multi-span reproduction: B must keep its CRLF even though the
    // same transaction inserts a line at the start and replaces the tail.
    const { state: initial, field } = makeState("A\nB\nC\nD\n", "lclc");
    const edited = dispatch(initial, { from: 0, insert: "X\n" }, { from: 6, to: 8, insert: "D!\n" });
    expect(edited.doc.toString()).toBe("X\nA\nB\nC\nD!\n");
    expect(mapOf(edited, field)).toBe("llcll");
    expect(latin1(serializeDocumentBytes(edited.doc.toString(), mapOf(edited, field), false))).toBe("X\nA\nB\r\nC\nD!\n");
  });

  it("matches repeated lines by position, not by content", () => {
    const { state: initial, field } = makeState("x\nx\nx\n", "clc");
    const edited = dispatch(initial, { from: 2, to: 4 });
    expect(edited.doc.toString()).toBe("x\nx\n");
    expect(mapOf(edited, field)).toBe("cc");
    expect(mapOf(undoOnce(edited), field)).toBe("clc");
  });

  it("inherits the preceding separator when Replace All inserts newlines", () => {
    const { state: initial, field } = makeState("head\na b", "c");
    const replaced = dispatch(initial, { from: 6, to: 7, insert: "\n" });
    expect(replaced.doc.toString()).toBe("head\na\nb");
    expect(mapOf(replaced, field)).toBe("cc");

    // With no neighbouring separator the file's preferred ending is used.
    const { state: plain, field: plainField } = makeState("a b", "", "crlf");
    const split = dispatch(plain, { from: 1, to: 2, insert: "\n" });
    expect(split.doc.toString()).toBe("a\nb");
    expect(mapOf(split, plainField)).toBe("c");
  });

  it("round trips bytes after undoing every edit back to the original file", () => {
    const originalBytes = new TextEncoder().encode("one\ntwo\r\nthree\nfour\n");
    const { state: initial, field } = makeState("one\ntwo\nthree\nfour\n", "lcll");
    let state = dispatch(initial, { from: 4, to: 7 }, { from: 0, insert: "X\n" });
    state = dispatch(state, { from: 6, to: 6, insert: "inserted\n" });
    expect(mapOf(state, field)).not.toBe("lcll");

    while (state.doc.toString() !== "one\ntwo\nthree\nfour\n") state = undoOnce(state);
    expect(mapOf(state, field)).toBe("lcll");
    const roundTripped = serializeDocumentBytes(state.doc.toString(), mapOf(state, field), false);
    expect(Array.from(roundTripped)).toEqual(Array.from(originalBytes));
  });

  it("keeps undo/redo cycles stable across consecutive history steps", () => {
    const { state: initial, field } = makeState("a\nb\nc\nd\n", "clcl");
    let state = dispatch(initial, { from: 2, to: 3, insert: "B!\nB2" });
    state = dispatch(state, { from: 0, to: 1, insert: "A" });
    const afterEdits = mapOf(state, field);
    state = undoOnce(state);
    state = undoOnce(state);
    expect(state.doc.toString()).toBe("a\nb\nc\nd\n");
    expect(mapOf(state, field)).toBe("clcl");
    state = redoOnce(state);
    expect(mapOf(state, field)).toBe(afterEdits);
    state = redoOnce(state);
    expect(state.doc.toString()).toBe("A\nb\nc\nd\n".replace("b", "B!\nB2"));
  });

  it("keeps portable separator history aligned when a selection-only event is undone", () => {
    const { state: initial, field } = makeState("a\nb", "c");
    const edited = dispatch(initial, { from: 3, insert: "\nx" });
    const selected = edited.update({
      selection: { anchor: 1 },
      annotations: Transaction.userEvent.of("select"),
    }).state;
    const portable = lineEndingMapOf(selected, field).history;

    expect(selected.doc.toString()).toBe("a\nb\nx");
    expect(mapOf(selected, field)).toBe("cc");
    expect(portable.done).toHaveLength(1);
    const selectionUndone = runHistoryCommand(selected, undoSelection);
    expect(selectionUndone.doc.toString()).toBe("a\nb\nx");
    expect(mapOf(selectionUndone, field)).toBe("cc");
    const selectionRedone = runHistoryCommand(selectionUndone, redoSelection);
    expect(selectionRedone.doc.toString()).toBe("a\nb\nx");
    expect(mapOf(selectionRedone, field)).toBe("cc");
    const editUndone = undoOnce(selectionRedone);
    expect(editUndone.doc.toString()).toBe("a\nb");
    expect(mapOf(editUndone, field)).toBe("c");
  });

  it("journals standalone selection events without attaching their undo to a later newline edit", () => {
    const { state: initial, field } = makeState("a\nb", "c");
    const selected = initial.update({
      selection: { anchor: 1 },
      annotations: Transaction.userEvent.of("select"),
    }).state;
    const edited = selected.update({ changes: { from: selected.doc.length, insert: "\nx" } }).state;

    expect(lineEndingMapOf(selected, field).history.done).toHaveLength(1);
    expect(lineEndingMapOf(edited, field).history.done).toHaveLength(2);
    const undone = undoOnce(edited);
    expect(undone.doc.toString()).toBe("a\nb");
    expect(mapOf(undone, field)).toBe("c");
  });

  it("keeps persistent separator history aligned after CodeMirror prunes a thousand edits", () => {
    const created = createLineEndingMapExtension("", "crlf");
    let state = EditorState.create({ doc: "start", extensions: [created.extension, history()] });
    for (let index = 0; index < 1000; index += 1) {
      state = state.update({
        changes: { from: state.doc.length, insert: "\nx" },
        annotations: [
          isolateHistory.of("full"),
          Transaction.userEvent.of("input.type"),
          Transaction.time.of(index * 1000),
        ],
      }).state;
    }
    const historyState = state.field(historyField) as { done: readonly unknown[] };
    const mapState = lineEndingMapOf(state, created.field);
    expect(historyState.done.length).toBeLessThan(1000);
    expect(mapState.history.done).toHaveLength(historyState.done.length);

    let remaining = state;
    while (undo({ state: remaining, dispatch: (transaction) => { remaining = transaction.state; } })) {
      const currentMap = lineEndingMapOf(remaining, created.field).map;
      expect(currentMap.length).toBe(remaining.doc.lines - 1);
      expect(lineEndingMapOf(remaining, created.field).crlf).toBe(currentMap.length);
    }
    expect(lineEndingMapOf(remaining, created.field).history.done).toHaveLength(0);
  });

  it("round trips a thousand newline edits on a 250k-separator document", () => {
    const separatorCount = 250_000;
    const content = "\n".repeat(separatorCount);
    const initialMarkers = "cl".repeat(separatorCount / 2);
    const created = createLineEndingMapExtension(initialMarkers, "lf");
    let state = EditorState.create({
      doc: content,
      extensions: [created.extension, history({ minDepth: 1100 })],
    });
    const maps = [lineEndingMapOf(state, created.field).map];

    for (let index = 0; index < 1000; index += 1) {
      state = state.update({
        changes: { from: state.doc.length, insert: "\nx" },
        annotations: [
          isolateHistory.of("full"),
          Transaction.userEvent.of("input.type"),
          Transaction.time.of(index * 1000),
        ],
      }).state;
      maps.push(lineEndingMapOf(state, created.field).map);
    }

    expect(lineEndingMapStorageBytes(maps)).toBeLessThan(separatorCount * 100);
    for (let index = 999; index >= 0; index -= 1) {
      state = undoOnce(state);
      const mapState = lineEndingMapOf(state, created.field);
      expect(mapState.map).toBe(maps[index]);
      expect(mapState.map.length).toBe(state.doc.lines - 1);
      expect(mapState.lf + mapState.crlf).toBe(mapState.map.length);
    }
    expect(mapOf(state, created.field)).toBe(initialMarkers);

    for (let index = 1; index <= 1000; index += 1) {
      state = redoOnce(state);
      const mapState = lineEndingMapOf(state, created.field);
      expect(mapState.map).toBe(maps[index]);
      expect(mapState.map.length).toBe(state.doc.lines - 1);
      expect(mapState.lf + mapState.crlf).toBe(mapState.map.length);
    }
    expect(mapOf(state, created.field)).toBe(lineEndingMapToString(maps[maps.length - 1]));
  });

  it("supports plugin multi-span edits without losing untouched separators", () => {
    const { state: initial, field } = makeState("alpha\nbeta\ngamma\ndelta\n", "lclc");
    const transaction = createPluginEditorEditTransaction(initial, 0, 0, [
      { from: 0, to: 5, insert: "ALPHA" },
      { from: 11, to: 16, insert: "GAMMA!" },
    ]);
    expect(transaction).toBeDefined();
    if (!transaction) return;
    const edited = transaction.state;
    expect(edited.doc.toString()).toBe("ALPHA\nbeta\nGAMMA!\ndelta\n");
    expect(mapOf(edited, field)).toBe("lclc");
    expect(latin1(serializeDocumentBytes(edited.doc.toString(), mapOf(edited, field), false))).toBe("ALPHA\nbeta\r\nGAMMA!\ndelta\r\n");

    const undone = undoOnce(edited);
    expect(undone.doc.toString()).toBe("alpha\nbeta\ngamma\ndelta\n");
    expect(mapOf(undone, field)).toBe("lclc");
  });

  it("normalizes carriage returns out of plugin inserts", () => {
    const { state: initial, field } = makeState("a\nb", "lc");
    const transaction = createPluginEditorEditTransaction(initial, 0, 0, [{ from: 0, to: 0, insert: "x\r\ny" }]);
    expect(transaction).toBeDefined();
    if (!transaction) return;
    expect(transaction.state.doc.toString()).toBe("x\nya\nb");
    expect(mapOf(transaction.state, field)).toBe("llc");
  });

  it("returns the previous map by reference for single-word typing", () => {
    // Plain typing must not rebuild the separator map. Reference
    // equality proves no per-separator work happened for the whole document.
    const lines = 50_000;
    const doc = "const value = 1;\n".repeat(lines);
    const { state: initial, field } = makeState(doc, "l".repeat(lines));
    let state = initial;
    for (let index = 0; index < 200; index += 1) {
      const offset = (index * 7919) % state.doc.length;
      state = dispatch(state, { from: offset, insert: "x" });
      expect(lineEndingMapOf(state, field).map).toBe(lineEndingMapOf(initial, field).map);
    }
  });

  it("only realigns separators around a newline edit in a large document", () => {
    const lines = 50_000;
    const doc = "line\n".repeat(lines);
    const { state: initial, field } = makeState(doc, "c".repeat(lines));
    const line = initial.doc.line(25_000);
    const state = dispatch(initial, { from: line.to, insert: "inserted\n" });
    const map = mapOf(state, field);
    expect(map).toHaveLength(lines + 1);
    expect(map[line.number - 1]).toBe("c");
    expect(map[line.number]).toBe("c");
    expect(state.doc.lines).toBe(lines + 2);
  });

  it("keeps a large pasted marker run in bounded persistent leaves", () => {
    const { state: initial, field } = makeState("head", "");
    const paste = "\nline".repeat(3000);
    const state = initial.update({ changes: { from: initial.doc.length, insert: paste } }).state;
    const map = lineEndingMapOf(state, field).map;
    const pending = [map];
    let maxLeafLength = 0;
    while (pending.length) {
      const node = pending.pop()!;
      if (node.kind === "leaf") maxLeafLength = Math.max(maxLeafLength, node.length);
      else pending.push(node.left, node.right);
    }

    expect(map.length).toBe(3000);
    expect(maxLeafLength).toBeLessThanOrEqual(1024);
  });

  it("reuses the map reference when a change removes and adds no separator", () => {
    const doc = "one\ntwo\nthree\n";
    const { state: initial, field } = makeState(doc, "clc");
    const transaction = initial.update({ changes: { from: 4, to: 7, insert: "TWO" } });
    const state = transaction.state;
    expect(mapOf(state, field)).toBe("clc");
    expect(lineEndingMapToString(reconcileLineEndingMapChanges(initial.doc, lineEndingMapOf(initial, field).map, transaction.changes, "lf"))).toBe("clc");
  });

  it("treats metadata differences as dirty even when the text matches", () => {
    const text = Text.of(["alpha", "beta", "gamma"]);
    const base = { text, savedText: text };
    expect(computeDocumentDirty({ ...base, lineEndings: "lc", savedLineEndings: "lc", bom: false, savedBom: false })).toBe(false);
    // Undoing back to identical text with a different separator map is dirty:
    // serializing it would produce different bytes.
    expect(computeDocumentDirty({ ...base, lineEndings: "ll", savedLineEndings: "lc", bom: false, savedBom: false })).toBe(true);
    expect(computeDocumentDirty({ ...base, lineEndings: "lc", savedLineEndings: "lc", bom: true, savedBom: false })).toBe(true);
    const changed = Text.of(["alpha", "beta!", "gamma"]);
    expect(computeDocumentDirty({ text: changed, savedText: text, lineEndings: "lc", savedLineEndings: "lc", bom: false, savedBom: false })).toBe(true);
  });

  it("compares independent roots exactly and handles string/rope forms", () => {
    const markers = `c${"l".repeat(2046)}c`;
    const left = lineEndingMapFromString(markers);
    const right = lineEndingMapFromString(markers);
    const metrics = { comparedMarkers: 0, sharedLeafMarkersSkipped: 0 };

    expect(left).not.toBe(right);
    expect(lineEndingMapsEqual(left, right, metrics)).toBe(true);
    expect(metrics).toEqual({ comparedMarkers: markers.length, sharedLeafMarkersSkipped: 0 });
    expect(lineEndingMapsEqual(markers, right)).toBe(true);
    expect(lineEndingMapsEqual(left, markers)).toBe(true);
    expect(lineEndingMapsEqual(`${markers.slice(0, -1)}l`, right)).toBe(false);
  });

  it("rejects a changed marker arrangement when LF/CRLF counts still match", () => {
    const original = `c${"l".repeat(2046)}c`;
    const changed = `lcl${"l".repeat(2044)}c`;
    const originalMap = lineEndingMapFromString(original);
    const changedMap = lineEndingMapFromString(changed);
    const metrics = { comparedMarkers: 0, sharedLeafMarkersSkipped: 0 };

    expect(original.length).toBe(changed.length);
    expect(originalMap.lf).toBe(changedMap.lf);
    expect(originalMap.crlf).toBe(changedMap.crlf);
    expect(lineEndingMapsEqual(originalMap, changedMap, metrics)).toBe(false);
    expect(metrics.comparedMarkers).toBeLessThan(original.length);
  });

  it("skips shared leaves before a same-count separator edit near the end", () => {
    const content = Array.from({ length: 4097 }, (_, index) => `row-${index}`).join("\n");
    const { state: initial, field } = makeState(content, "l".repeat(4096));
    const originalMap = lineEndingMapOf(initial, field).map;
    const firstBreak = initial.doc.line(initial.doc.lines - 2).to;
    const finalLine = initial.doc.line(initial.doc.lines);
    const transaction = initial.update({ changes: [
      { from: firstBreak, to: firstBreak + 1, insert: "" },
      { from: finalLine.from + 2, insert: "\n" },
    ] });
    const changedMap = lineEndingMapOf(transaction.state, field).map;
    const metrics = { comparedMarkers: 0, sharedLeafMarkersSkipped: 0 };

    expect(changedMap).not.toBe(originalMap);
    expect(changedMap.length).toBe(originalMap.length);
    expect(changedMap.lf).toBe(originalMap.lf);
    expect(changedMap.crlf).toBe(originalMap.crlf);
    expect(lineEndingMapsEqual(originalMap, changedMap, metrics)).toBe(true);
    expect(metrics.sharedLeafMarkersSkipped).toBeGreaterThan(0);
    expect(metrics.comparedMarkers).toBeLessThan(originalMap.length);
  });

  it("tracks the saved baseline across edits made while saving", () => {
    // Models the editor-side baseline update after a save completes while
    // the user keeps typing: only the saved revision's baseline moves.
    const { state: initial, field } = makeState("alpha\nbeta\n", "lc");
    const dirty = (state: EditorState, saved: EditorState) => computeDocumentDirty({
      text: state.doc,
      savedText: saved.doc,
      lineEndings: mapOf(state, field),
      savedLineEndings: mapOf(saved, field),
      bom: false,
      savedBom: false,
    });

    const edited = dispatch(initial, { from: 0, to: 5, insert: "ALPHA" });
    expect(dirty(edited, initial)).toBe(true);
    // Save completes: the baseline advances to the edited document.
    expect(dirty(edited, edited)).toBe(false);
    // Typing during the save keeps the document dirty. The edit stays clear
    // of the earlier change so undo pops only this transaction.
    const typed = dispatch(edited, { from: edited.doc.length, insert: "!" });
    expect(dirty(typed, edited)).toBe(true);
    // Undoing that typing returns to the just-saved clean state.
    expect(dirty(undoOnce(typed), edited)).toBe(false);
  });

  it("survives editor state serialization like the detached editor cache", () => {
    const { state: initial, field } = makeState("alpha\nbeta\ngamma", "lc");
    const edited = dispatch(initial, { from: 0, to: 5, insert: "ALPHA" });
    const map = mapOf(edited, field);
    const historyJSON = serializeEditorHistory(edited);
    expect(historyJSON).toBeDefined();
    if (historyJSON === undefined) return;
    // A rehydrated state rebuilds the map from the captured document record,
    // matching how the detached editor cache restores text, history, and
    // metadata together.
    const recreated = createLineEndingMapExtension(map, "lf");
    const state = EditorState.fromJSON(
      { doc: edited.doc.toString(), selection: edited.selection.toJSON(), history: historyJSON },
      { extensions: [recreated.extension, history()] },
      { history: historyField },
    );
    expect(state.doc.toString()).toBe("ALPHA\nbeta\ngamma");
    expect(mapOf(state, recreated.field)).toBe("lc");
    // Non-separator edits remain undoable after rehydration.
    const undone = undoOnce(state);
    expect(undone.doc.toString()).toBe("alpha\nbeta\ngamma");
  });

  it("restores mixed separators after detached undo and redo using shared marker roots", () => {
    const lines = 100_000;
    const content = "row\n".repeat(lines);
    const { state: initial, field } = makeState(content, "cl".repeat(lines / 2));
    const originalMap = lineEndingMapOf(initial, field).map;
    const first = initial.update({ changes: { from: 1, insert: "\nnew" }, userEvent: "input.paste" }).state;
    const firstMap = lineEndingMapOf(first, field).map;
    const second = first.update({ changes: { from: first.doc.length, insert: "\nend" }, userEvent: "input.paste" }).state;
    const secondMap = lineEndingMapOf(second, field).map;
    const historyJSON = serializeEditorHistory(second);
    const portableHistory = lineEndingMapOf(second, field).history;
    expect(portableHistory.done).toHaveLength(2);
    expect(lineEndingMapStorageBytes([originalMap, firstMap, secondMap])).toBeLessThan(
      (originalMap.length + firstMap.length + secondMap.length) * 1.4,
    );
    expect(historyJSON).toBeDefined();
    if (historyJSON === undefined) return;

    const restoredMap = createLineEndingMapExtension(secondMap, "lf", portableHistory);
    let restored = EditorState.fromJSON(
      { doc: second.doc.toString(), selection: second.selection.toJSON(), history: historyJSON },
      { extensions: [restoredMap.extension, history()] },
      { history: historyField },
    );
    restored = undoOnce(restored);
    expect(mapOf(restored, restoredMap.field)).toBe(lineEndingMapToString(firstMap));
    expect(restored.doc.toString()).toBe(first.doc.toString());
    restored = undoOnce(restored);
    expect(mapOf(restored, restoredMap.field)).toBe(lineEndingMapToString(originalMap));
    expect(restored.doc.toString()).toBe(content);
    restored = redoOnce(restored);
    expect(mapOf(restored, restoredMap.field)).toBe(lineEndingMapToString(firstMap));
    restored = redoOnce(restored);
    expect(mapOf(restored, restoredMap.field)).toBe(lineEndingMapToString(secondMap));
  });

  it("uses the stored preferred ending on a count tie without walking markers", () => {
    const { state: initial, field } = makeState("a\nb\nc", "cl", "crlf");
    const map = lineEndingMapOf(initial, field).map;
    expect(lineEndingMapToString(map)).toBe("cl");
    const created = createLineEndingMapExtension(map, "crlf");
    const state = EditorState.create({ doc: "a\nb\nc", extensions: [created.extension] });
    expect(majorityLineEnding(lineEndingMapOf(state, created.field))).toBe("crlf");
  });

  it("keeps Save As history through cache restore with BOM and mixed-ending bytes", () => {
    const original = "alpha\nbeta\ngamma";
    const { state: initial, field } = makeState(original, "cl");
    const edited = dispatch(initial, { from: 6, to: 10, insert: "BETA" });
    const savedContent = edited.doc.toString();
    const savedLineEndings = mapOf(edited, field);
    const savedBom = true;
    const originalBytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("alpha\r\nbeta\ngamma")]);

    // Save As advances the saved baseline without changing the live history.
    const savedText = Text.of(savedContent.split("\n"));
    expect(computeDocumentDirty({
      text: edited.doc,
      savedText,
      lineEndings: savedLineEndings,
      savedLineEndings,
      bom: savedBom,
      savedBom,
    })).toBe(false);

    const historyJSON = serializeEditorHistory(edited);
    expect(historyJSON).toBeDefined();
    if (historyJSON === undefined) return;
    const restoredMap = createLineEndingMapExtension(savedLineEndings, "lf");
    let restored = EditorState.fromJSON(
      { doc: savedContent, selection: edited.selection.toJSON(), history: historyJSON },
      { extensions: [restoredMap.extension, history()] },
      { history: historyField },
    );

    const typed = dispatch(restored, { from: restored.doc.length, insert: "-next" });
    expect(typed.doc.toString()).toBe("alpha\nBETA\ngamma-next");
    expect(Array.from(serializeDocumentBytes(typed.doc.toString(), mapOf(typed, restoredMap.field), savedBom))).toEqual(
      Array.from(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("alpha\r\nBETA\ngamma-next")])),
    );
    expect(computeDocumentDirty({
      text: typed.doc,
      savedText,
      lineEndings: mapOf(typed, restoredMap.field),
      savedLineEndings,
      bom: savedBom,
      savedBom,
    })).toBe(true);

    restored = undoOnce(typed);
    expect(restored.doc.toString()).toBe(savedContent);
    expect(mapOf(restored, restoredMap.field)).toBe(savedLineEndings);
    expect(computeDocumentDirty({
      text: restored.doc,
      savedText,
      lineEndings: mapOf(restored, restoredMap.field),
      savedLineEndings,
      bom: savedBom,
      savedBom,
    })).toBe(false);

    restored = undoOnce(restored);
    expect(restored.doc.toString()).toBe(original);
    expect(mapOf(restored, restoredMap.field)).toBe("cl");
    expect(Array.from(serializeDocumentBytes(restored.doc.toString(), mapOf(restored, restoredMap.field), savedBom))).toEqual(Array.from(originalBytes));
  });
});
