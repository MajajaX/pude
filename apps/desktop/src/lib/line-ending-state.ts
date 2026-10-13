import { historyField, invertedEffects } from "@codemirror/commands";
import { StateEffect, StateField, Transaction, type ChangeSet, type EditorState, type Extension, type Text } from "@codemirror/state";
export { lineEndingMapStorageBytes } from "./editor-cache-budget";

type Marker = "l" | "c";

type Leaf = {
  kind: "leaf";
  value: string;
  length: number;
  lf: number;
  crlf: number;
  height: 1;
};

type Branch = {
  kind: "branch";
  left: LineEndingMap;
  right: LineEndingMap;
  length: number;
  lf: number;
  crlf: number;
  height: number;
};

/** A persistent, structurally shared sequence of LF/CRLF markers. */
export type LineEndingMap = Leaf | Branch;

export type LineEndingHistoryEvent = {
  before: LineEndingMap;
  after: LineEndingMap;
};

export type LineEndingHistory = {
  done: readonly LineEndingHistoryEvent[];
  undone: readonly LineEndingHistoryEvent[];
};

export type LineEndingMapState = {
  map: LineEndingMap;
  preferred: "lf" | "crlf";
  lf: number;
  crlf: number;
  history: LineEndingHistory;
};

type ChangePiece = {
  fromA: number;
  toA: number;
  inserted: Text;
};

type HistoryBranch = { done: readonly unknown[]; undone: readonly unknown[] };

const LEAF_CHUNK_SIZE = 1024;
const EMPTY_MAP = makeLeaf("");

function makeLeaf(value: string): Leaf {
  let lf = 0;
  let crlf = 0;
  for (const marker of value) {
    if (marker === "c") crlf += 1;
    else lf += 1;
  }
  return { kind: "leaf", value, length: value.length, lf, crlf, height: 1 };
}

function makeBranch(left: LineEndingMap, right: LineEndingMap): Branch {
  return {
    kind: "branch",
    left,
    right,
    length: left.length + right.length,
    lf: left.lf + right.lf,
    crlf: left.crlf + right.crlf,
    height: Math.max(left.height, right.height) + 1,
  };
}

function balance(left: LineEndingMap, right: LineEndingMap): LineEndingMap {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  if (left.height > right.height + 1 && left.kind === "branch") {
    if (left.left.height >= left.right.height) return makeBranch(left.left, concat(left.right, right));
    if (left.right.kind === "branch") {
      return makeBranch(makeBranch(left.left, left.right.left), concat(left.right.right, right));
    }
  }
  if (right.height > left.height + 1 && right.kind === "branch") {
    if (right.right.height >= right.left.height) return makeBranch(concat(left, right.left), right.right);
    if (right.left.kind === "branch") {
      return makeBranch(concat(left, right.left.left), makeBranch(right.left.right, right.right));
    }
  }
  return makeBranch(left, right);
}

function concat(left: LineEndingMap, right: LineEndingMap): LineEndingMap {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  if (left.height > right.height + 1 && left.kind === "branch") {
    return balance(left.left, concat(left.right, right));
  }
  if (right.height > left.height + 1 && right.kind === "branch") {
    return balance(concat(left, right.left), right.right);
  }
  return makeBranch(left, right);
}

function join(nodes: readonly LineEndingMap[]): LineEndingMap {
  if (nodes.length === 0) return EMPTY_MAP;
  let level = [...nodes];
  while (level.length > 1) {
    const next: LineEndingMap[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length ? concat(level[index], level[index + 1]) : level[index]);
    }
    level = next;
  }
  return level[0];
}

export function lineEndingMapFromString(value: string): LineEndingMap {
  if (!value) return EMPTY_MAP;
  const chunks: LineEndingMap[] = [];
  for (let index = 0; index < value.length; index += LEAF_CHUNK_SIZE) {
    const part = value.slice(index, index + LEAF_CHUNK_SIZE);
    chunks.push(makeLeaf(part.replace(/[^lc]/g, "l")));
  }
  return join(chunks);
}

export function lineEndingMapLength(map: LineEndingMap): number {
  return map.length;
}

export function lineEndingMapToString(map: LineEndingMap): string {
  if (map.kind === "leaf") return map.value;
  const parts: string[] = [];
  const stack: LineEndingMap[] = [map];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.kind === "leaf") parts.push(current.value);
    else {
      stack.push(current.right);
      stack.push(current.left);
    }
  }
  return parts.join("");
}

export type LineEndingMapComparisonMetrics = {
  comparedMarkers: number;
  sharedLeafMarkersSkipped: number;
};

type MarkerSegment = { value: string; leaf?: Leaf };

function* markerSegments(source: LineEndingMap | string): Generator<MarkerSegment> {
  if (typeof source === "string") {
    if (source.length) yield { value: source };
    return;
  }

  const stack: LineEndingMap[] = [source];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.kind === "leaf") {
      if (node.length) yield { value: node.value, leaf: node };
    } else {
      stack.push(node.right, node.left);
    }
  }
}

function compareMarkerSegments(
  left: LineEndingMap | string,
  right: LineEndingMap | string,
  metrics?: LineEndingMapComparisonMetrics,
): boolean {
  const leftIterator = markerSegments(left);
  const rightIterator = markerSegments(right);
  let leftSegment = leftIterator.next().value as MarkerSegment | undefined;
  let rightSegment = rightIterator.next().value as MarkerSegment | undefined;
  let leftOffset = 0;
  let rightOffset = 0;

  while (leftSegment && rightSegment) {
    const leftRemaining = leftSegment.value.length - leftOffset;
    const rightRemaining = rightSegment.value.length - rightOffset;
    if (leftSegment.leaf && leftSegment.leaf === rightSegment.leaf && leftOffset === rightOffset) {
      metrics && (metrics.sharedLeafMarkersSkipped += leftRemaining);
      leftSegment = leftIterator.next().value as MarkerSegment | undefined;
      rightSegment = rightIterator.next().value as MarkerSegment | undefined;
      leftOffset = 0;
      rightOffset = 0;
      continue;
    }

    const span = Math.min(leftRemaining, rightRemaining);
    for (let index = 0; index < span; index += 1) {
      const equal = leftSegment.value.charCodeAt(leftOffset + index) === rightSegment.value.charCodeAt(rightOffset + index);
      if (metrics) metrics.comparedMarkers += 1;
      if (!equal) return false;
    }
    leftOffset += span;
    rightOffset += span;
    if (leftOffset === leftSegment.value.length) {
      leftSegment = leftIterator.next().value as MarkerSegment | undefined;
      leftOffset = 0;
    }
    if (rightOffset === rightSegment.value.length) {
      rightSegment = rightIterator.next().value as MarkerSegment | undefined;
      rightOffset = 0;
    }
  }

  return leftSegment === undefined && rightSegment === undefined;
}

export function lineEndingMapMarkerAt(map: LineEndingMap, index: number): Marker | undefined {
  if (index < 0 || index >= map.length) return undefined;
  let node = map;
  let offset = index;
  while (node.kind === "branch") {
    if (offset < node.left.length) node = node.left;
    else {
      offset -= node.left.length;
      node = node.right;
    }
  }
  return node.value[offset] === "c" ? "c" : "l";
}

export function lineEndingMapSlice(map: LineEndingMap, from: number, to: number): LineEndingMap {
  const start = Math.max(0, Math.min(map.length, from));
  const end = Math.max(start, Math.min(map.length, to));
  if (start === 0 && end === map.length) return map;
  if (start === end) return EMPTY_MAP;
  if (map.kind === "leaf") return makeLeaf(map.value.slice(start, end));

  const leftLength = map.left.length;
  if (end <= leftLength) return lineEndingMapSlice(map.left, start, end);
  if (start >= leftLength) return lineEndingMapSlice(map.right, start - leftLength, end - leftLength);
  return concat(lineEndingMapSlice(map.left, start, leftLength), lineEndingMapSlice(map.right, 0, end - leftLength));
}

function markerMap(marker: Marker, count: number): LineEndingMap {
  if (count <= 0) return EMPTY_MAP;
  const chunks: LineEndingMap[] = [];
  for (let remaining = count; remaining > 0; remaining -= LEAF_CHUNK_SIZE) {
    chunks.push(makeLeaf(marker.repeat(Math.min(remaining, LEAF_CHUNK_SIZE))));
  }
  return join(chunks);
}

function lastMarker(map: LineEndingMap): Marker | undefined {
  if (map.length === 0) return undefined;
  return lineEndingMapMarkerAt(map, map.length - 1);
}

function separatorsBefore(doc: { lineAt: (pos: number) => { number: number } }, pos: number): number {
  return doc.lineAt(pos).number - 1;
}

function mapRoot(effect: unknown): LineEndingMap | undefined {
  const candidate = effect as { is?: (type: typeof restoreLineEndingMapEffect) => boolean; value?: LineEndingMap } | undefined;
  return candidate?.is?.(restoreLineEndingMapEffect) ? candidate.value : undefined;
}

const restoreLineEndingMapEffect = StateEffect.define<LineEndingMap>();

function normalizeHistory(history: LineEndingHistory): LineEndingHistory {
  return { done: history.done, undone: history.undone };
}

function historyBranch(state: EditorState): HistoryBranch | undefined {
  return state.field(historyField, false) as HistoryBranch | undefined;
}

/**
 * Reconcile the separator map for one transaction. Unchanged ranges reuse
 * existing rope nodes, while only the inserted marker run and split paths are
 * allocated. Plain text changes return the original map by reference.
 */
export function reconcileLineEndingMapChanges(
  previousDoc: { lineAt: (pos: number) => { number: number } },
  previousMap: LineEndingMap,
  changes: Pick<ChangeSet, "iterChanges">,
  preferred: "lf" | "crlf",
): LineEndingMap {
  const pieces: ChangePiece[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    pieces.push({ fromA, toA, inserted });
  });
  let touchesMap = false;
  for (const piece of pieces) {
    if (separatorsBefore(previousDoc, piece.toA) !== separatorsBefore(previousDoc, piece.fromA) || piece.inserted.lines > 1) {
      touchesMap = true;
      break;
    }
  }
  if (!touchesMap) return previousMap;

  const result: LineEndingMap[] = [];
  let consumed = 0;
  let outputLength = 0;
  for (const piece of pieces) {
    const before = separatorsBefore(previousDoc, piece.fromA);
    const through = separatorsBefore(previousDoc, piece.toA);
    const prefix = lineEndingMapSlice(previousMap, consumed, before);
    if (prefix.length) result.push(prefix);
    outputLength += prefix.length;
    consumed = through;

    const insertedBreaks = piece.inserted.lines - 1;
    if (insertedBreaks > 0) {
      const preceding = outputLength ? lastMarker(result[result.length - 1]) : undefined;
      const following = lineEndingMapMarkerAt(previousMap, consumed);
      const inherited = preceding ?? following ?? (preferred === "crlf" ? "c" : "l");
      const inserted = markerMap(inherited, insertedBreaks);
      result.push(inserted);
      outputLength += inserted.length;
    }
  }
  const suffix = lineEndingMapSlice(previousMap, consumed, previousMap.length);
  if (suffix.length) result.push(suffix);
  return join(result);
}

/** Compare exact marker sequences while skipping shared persistent leaves. */
export function lineEndingMapsEqual(
  left: LineEndingMap | string,
  right: LineEndingMap | string,
  metrics?: LineEndingMapComparisonMetrics,
): boolean {
  if (left === right) return true;
  if (typeof left === "string" && typeof right === "string") return left === right;
  if (typeof left !== "string" && typeof right !== "string"
    && (left.length !== right.length || left.lf !== right.lf || left.crlf !== right.crlf)) return false;
  return left.length === right.length && compareMarkerSegments(left, right, metrics);
}

/** Dirty when text, exact separators, or BOM differs from the saved version. */
export function computeDocumentDirty(options: {
  text: Text;
  savedText: Text;
  lineEndings: LineEndingMap | string;
  savedLineEndings: LineEndingMap | string;
  bom: boolean;
  savedBom: boolean;
}): boolean {
  return !options.text.eq(options.savedText)
    || !lineEndingMapsEqual(options.lineEndings, options.savedLineEndings)
    || options.bom !== options.savedBom;
}

function updatePortableHistory(
  previous: LineEndingHistory,
  tr: Transaction,
  mapBefore: LineEndingMap,
  mapAfter: LineEndingMap,
): LineEndingHistory {
  const before = historyBranch(tr.startState);
  const after = historyBranch(tr.state);
  if (!before || !after) return previous;

  const userEvent = tr.annotation(Transaction.userEvent);
  // Selection-only history steps change stored cursor positions, not the
  // document event or its line-ending effect.
  if (userEvent === "select.undo" || userEvent === "select.redo") return previous;
  if (userEvent === "undo") {
    if (!previous.done.length) return previous;
    const event = previous.done[previous.done.length - 1];
    return { done: previous.done.slice(0, -1), undone: [...previous.undone, event] };
  }
  if (userEvent === "redo") {
    if (!previous.undone.length) return previous;
    const event = previous.undone[previous.undone.length - 1];
    return { done: [...previous.done, event], undone: previous.undone.slice(0, -1) };
  }
  if (tr.annotation(Transaction.addToHistory) === false) return previous;

  const beforeDone = before.done.length;
  const afterDone = after.done.length;
  if (!tr.docChanged) {
    if (afterDone > beforeDone) {
      const dropped = Math.max(0, previous.done.length + 1 - afterDone);
      return {
        done: [...previous.done.slice(dropped), { before: mapBefore, after: mapAfter }],
        undone: previous.undone,
      };
    }
    if (afterDone < beforeDone) {
      return { ...previous, done: previous.done.slice(Math.max(0, beforeDone - afterDone)) };
    }
    return previous;
  }
  if (afterDone > beforeDone) {
    const dropped = Math.max(0, previous.done.length + 1 - afterDone);
    const done = previous.done.slice(dropped);
    return {
      done: [...done, { before: mapBefore, after: mapAfter }],
      undone: [],
    };
  }
  if (afterDone === beforeDone && beforeDone > 0 && previous.done.length > 0) {
    if (mapAfter === mapBefore && previous.done[previous.done.length - 1].after === mapAfter && previous.undone.length === 0) {
      return previous;
    }
    const done = [...previous.done];
    const last = done.length - 1;
    done[last] = { before: done[last].before, after: mapAfter };
    return { done, undone: [] };
  }
  if (afterDone < beforeDone) {
    // The CodeMirror history depth can prune older entries as it reaches its
    // configured limit. Keep the metadata journal aligned with that branch.
    const dropped = Math.max(0, previous.done.length + 1 - afterDone);
    return {
      done: [...previous.done.slice(dropped), { before: mapBefore, after: mapAfter }],
      undone: [],
    };
  }
  return previous;
}

export function markerForLineEndingCount(preferred: "lf" | "crlf"): string {
  return preferred === "crlf" ? "c" : "l";
}

export function createLineEndingMapExtension(
  initialMap: string | LineEndingMap,
  preferred: "lf" | "crlf",
  initialHistory: LineEndingHistory = { done: [], undone: [] },
): { extension: Extension; field: StateField<LineEndingMapState> } {
  const map = typeof initialMap === "string" ? lineEndingMapFromString(initialMap) : initialMap;
  const field = StateField.define<LineEndingMapState>({
    create: () => ({ map, preferred, lf: map.lf, crlf: map.crlf, history: normalizeHistory(initialHistory) }),
    update(value, tr: Transaction) {
      let restored: LineEndingMap | undefined;
      for (const effect of tr.effects) restored = mapRoot(effect) ?? restored;

      if (tr.docChanged) {
        if (restored) {
          const history = updatePortableHistory(value.history, tr, value.map, restored);
          return { map: restored, preferred, lf: restored.lf, crlf: restored.crlf, history };
        }
        const map = reconcileLineEndingMapChanges(tr.startState.doc, value.map, tr.changes, value.preferred);
        const history = updatePortableHistory(value.history, tr, value.map, map);
        if (map === value.map && history === value.history) return value;
        return { map, preferred, lf: map.lf, crlf: map.crlf, history };
      }

      const history = updatePortableHistory(value.history, tr, value.map, value.map);
      return history === value.history ? value : { ...value, history };
    },
  });
  const extension: Extension = [
    field,
    invertedEffects.of((tr) => {
      if (!tr.docChanged) return [];
      const value = tr.startState.field(field, false);
      return value ? [restoreLineEndingMapEffect.of(value.map)] : [];
    }),
  ];
  return { extension, field };
}

export function lineEndingMapOf(state: EditorState, field: StateField<LineEndingMapState>): LineEndingMapState {
  return state.field(field);
}

/** Majority selection stays constant time, including the tie case. */
export function majorityLineEnding(state: LineEndingMapState): "lf" | "crlf" {
  return state.crlf > state.lf ? "crlf" : state.lf > state.crlf ? "lf" : state.preferred;
}
