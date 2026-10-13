import { pathComparisonKey, type PathIdentityOptions } from "./path-identity";

export type VirtualTreeEntry = {
  name: string;
  kind: "file" | "directory" | "symlink";
  children?: readonly VirtualTreeEntry[];
  expanded?: boolean;
};

export type VisibleTreeRow<T extends VirtualTreeEntry = VirtualTreeEntry> = {
  entry: T;
  depth: number;
  isRoot: boolean;
  siblingIndex: number;
  siblingCount: number;
  parentIndex: number;
};

export type IndexedVisibleTreeRow<T extends VirtualTreeEntry & { path: string }> = VisibleTreeRow<T> & {
  /** Absolute index in the model's flat row array. */
  index: number;
  /** Cached once for this entry object; never recomputed while scrolling. */
  pathKey: string;
  /** Number of rows in this row's visible subtree, including the row itself. */
  subtreeSize: number;
};

export type VisibleTreeModelChange<T extends VirtualTreeEntry & { path: string }> = {
  version: number;
  changed: boolean;
  changedRows: readonly IndexedVisibleTreeRow<T>[];
  removedPathKeys: readonly string[];
};

export type VisibleTreeModelStats = {
  fullBuilds: number;
  incrementalUpdates: number;
  visibleEntriesFlattened: number;
  directChildEntriesVisited: number;
  directChildEntriesCompared: number;
  pathKeysComputed: number;
  indexMapBuilds: number;
  indexMapWrites: number;
  indexLookups: number;
  rowsUpdated: number;
  rowsInserted: number;
  rowsRemoved: number;
  rowsShifted: number;
};

export function flattenVisibleTree<T extends VirtualTreeEntry>(root: T, hideDotFiles: boolean): VisibleTreeRow<T>[] {
  const rows: VisibleTreeRow<T>[] = [];
  const pending: Array<{ entry: T; depth: number; isRoot: boolean; siblingIndex: number; siblingCount: number; parentIndex: number }> = [
    { entry: root, depth: 0, isRoot: true, siblingIndex: 0, siblingCount: 1, parentIndex: -1 },
  ];

  while (pending.length) {
    const current = pending.pop();
    if (!current || (hideDotFiles && current.entry.name.startsWith("."))) continue;
    const index = rows.length;
    rows.push(current);

    if (current.entry.kind !== "directory" || !current.entry.expanded) continue;
    const children = visibleChildren(current.entry, hideDotFiles);
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
      pending.push({
        entry: children[childIndex] as T,
        depth: current.depth + 1,
        isRoot: false,
        siblingIndex: childIndex,
        siblingCount: children.length,
        parentIndex: index,
      });
    }
  }
  return rows;
}

export type TreeKeyboardAction = { kind: "focus"; index: number } | { kind: "toggle" } | { kind: "open" };

export function treeKeyboardAction(rows: readonly VisibleTreeRow[], index: number, key: string): TreeKeyboardAction | undefined {
  const row = rows[index];
  if (!row) return;
  if (key === "Home") return { kind: "focus", index: 0 };
  if (key === "End") return { kind: "focus", index: rows.length - 1 };
  if (key === "ArrowDown") return { kind: "focus", index: Math.min(index + 1, rows.length - 1) };
  if (key === "ArrowUp") return { kind: "focus", index: Math.max(index - 1, 0) };
  if (key === "Enter" || key === " ") return { kind: row.entry.kind === "directory" ? "toggle" : "open" };
  if (key === "ArrowRight" && row.entry.kind === "directory") {
    if (!row.entry.expanded) return { kind: "toggle" };
    const child = rows[index + 1];
    if (child && child.parentIndex === index) return { kind: "focus", index: index + 1 };
  }
  if (key === "ArrowLeft") {
    if (row.entry.kind === "directory" && row.entry.expanded) return { kind: "toggle" };
    if (row.parentIndex >= 0) return { kind: "focus", index: row.parentIndex };
  }
}

/**
 * Maintains a flat visible-tree model and its path index. A changed entry only
 * causes its visible subtree to be revisited. When a parent's direct child
 * list changes, direct children are compared to locate the changed interval;
 * this cost is bounded by that parent's degree, not the complete visible
 * tree. One contiguous flat interval is replaced and the index map is patched.
 * Inserting/deleting rows in a flat array necessarily shifts indices in the
 * suffix, which is counted in `stats.rowsShifted`.
 */
export class VisibleTreeModel<T extends VirtualTreeEntry & { path: string }> {
  readonly rows: IndexedVisibleTreeRow<T>[] = [];
  readonly stats: VisibleTreeModelStats = {
    fullBuilds: 0,
    incrementalUpdates: 0,
    visibleEntriesFlattened: 0,
    directChildEntriesVisited: 0,
    directChildEntriesCompared: 0,
    pathKeysComputed: 0,
    indexMapBuilds: 0,
    indexMapWrites: 0,
    indexLookups: 0,
    rowsUpdated: 0,
    rowsInserted: 0,
    rowsRemoved: 0,
    rowsShifted: 0,
  };

  private readonly indexByPathKey = new Map<string, number>();
  private readonly entryKeyCache = new WeakMap<object, { path: string; key: string }>();
  private previousRoot: T | undefined;
  private previousHideDotFiles: boolean | undefined;
  private currentVersion = 0;
  private changedRows = new Set<IndexedVisibleTreeRow<T>>();
  private removedPathKeys: string[] = [];
  private didChange = false;

  constructor(private readonly pathOptions: PathIdentityOptions = {}) {}

  get version(): number {
    return this.currentVersion;
  }

  get lastChange(): VisibleTreeModelChange<T> {
    return {
      version: this.currentVersion,
      changed: this.didChange,
      changedRows: [...this.changedRows],
      removedPathKeys: [...this.removedPathKeys],
    };
  }

  update(root: T, hideDotFiles: boolean): boolean {
    this.changedRows = new Set();
    this.removedPathKeys = [];
    this.didChange = false;

    if (this.previousRoot === undefined || this.previousHideDotFiles !== hideDotFiles || !sameEntryPath(this.previousRoot, root, (entry) => this.keyForEntry(entry))) {
      this.rebuild(root, hideDotFiles);
    } else if (this.previousRoot !== root) {
      this.stats.incrementalUpdates += 1;
      this.updateEntry(this.previousRoot, root, 0, 0, true, 0, 1, -1, hideDotFiles);
      this.previousRoot = root;
      if (this.changedRows.size || this.removedPathKeys.length) this.finishChange();
    }

    return this.didChange;
  }

  indexOfKey(pathKey: string): number {
    this.stats.indexLookups += 1;
    return this.indexByPathKey.get(pathKey) ?? -1;
  }

  indexOfPath(path: string): number {
    this.stats.indexLookups += 1;
    return this.indexByPathKey.get(this.keyForPath(path)) ?? -1;
  }

  keyOfPath(path: string): string {
    return this.keyForPath(path);
  }

  private rebuild(root: T, hideDotFiles: boolean): void {
    this.stats.fullBuilds += 1;
    const previousKeys = this.rows.map((row) => row.pathKey);
    this.indexByPathKey.clear();
    this.rows.length = 0;

    const pending: Array<{ entry: T; depth: number; isRoot: boolean; siblingIndex: number; siblingCount: number; parentIndex: number }> = [
      { entry: root, depth: 0, isRoot: true, siblingIndex: 0, siblingCount: 1, parentIndex: -1 },
    ];
    while (pending.length) {
      const current = pending.pop();
      if (!current || (hideDotFiles && current.entry.name.startsWith("."))) continue;
      const index = this.rows.length;
      const row: IndexedVisibleTreeRow<T> = {
        ...current,
        index,
        pathKey: this.keyForEntry(current.entry),
        subtreeSize: 1,
      };
      this.rows.push(row);
      this.stats.visibleEntriesFlattened += 1;

      if (current.entry.kind !== "directory" || !current.entry.expanded) continue;
      const children = this.visibleChildren(current.entry, hideDotFiles);
      for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
        pending.push({
          entry: children[childIndex] as T,
          depth: current.depth + 1,
          isRoot: false,
          siblingIndex: childIndex,
          siblingCount: children.length,
          parentIndex: index,
        });
      }
    }

    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      const row = this.rows[index];
      if (row.parentIndex >= 0) this.rows[row.parentIndex].subtreeSize += row.subtreeSize;
      this.changedRows.add(row);
    }
    const nextKeys = new Set(this.rows.map((row) => row.pathKey));
    for (const previousKey of previousKeys) {
      if (!nextKeys.has(previousKey)) this.removedPathKeys.push(previousKey);
    }
    this.indexByPathKey.clear();
    for (const row of this.rows) {
      this.indexByPathKey.set(row.pathKey, row.index);
      this.stats.indexMapWrites += 1;
    }
    this.stats.indexMapBuilds += 1;
    this.previousRoot = root;
    this.previousHideDotFiles = hideDotFiles;
    this.finishChange();
  }

  private updateEntry(
    previous: T,
    next: T,
    expectedIndex: number,
    depth: number,
    isRoot: boolean,
    siblingIndex: number,
    siblingCount: number,
    parentIndex: number,
    hideDotFiles: boolean,
  ): void {
    const key = this.keyForEntry(next);
    const index = this.indexByPathKey.get(key);
    if (index === undefined) {
      // A path identity change is a remove plus insert at the owning parent's
      // child-list boundary. The root has no owner, so rebuild conservatively.
      if (isRoot) this.rebuild(next, hideDotFiles);
      return;
    }
    const row = this.rows[index];
    if (!row || (index !== expectedIndex && isRoot)) return;

    let rowChanged = false;
    if (row.entry !== next) { row.entry = next; rowChanged = true; }
    if (row.depth !== depth) { row.depth = depth; rowChanged = true; }
    if (row.isRoot !== isRoot) { row.isRoot = isRoot; rowChanged = true; }
    if (row.siblingIndex !== siblingIndex) { row.siblingIndex = siblingIndex; rowChanged = true; }
    if (row.siblingCount !== siblingCount) { row.siblingCount = siblingCount; rowChanged = true; }
    if (row.parentIndex !== parentIndex) { row.parentIndex = parentIndex; rowChanged = true; }
    if (rowChanged) this.markChanged(row);

    const wasExpanded = previous.kind === "directory" && Boolean(previous.expanded);
    const isExpanded = next.kind === "directory" && Boolean(next.expanded);
    if (!wasExpanded && !isExpanded) return;

    if (!wasExpanded && isExpanded) {
      const newChildren = this.visibleChildren(next, hideDotFiles);
      const inserted = this.flattenChildren(newChildren, index, row.depth + 1, 0, newChildren.length, hideDotFiles);
      this.replaceFlatRange(index, index + 1, index + 1, inserted);
      this.setDirectChildSemantics(index, newChildren);
      return;
    }
    if (wasExpanded && !isExpanded) {
      this.replaceFlatRange(index, index + 1, index + row.subtreeSize, []);
      return;
    }

    if (previous.children === next.children) return;

    const oldChildren = this.visibleChildren(previous, hideDotFiles);
    const newChildren = this.visibleChildren(next, hideDotFiles);
    let sameKeys = oldChildren.length === newChildren.length;
    const changedChildIndexes: number[] = [];
    if (sameKeys) {
      for (let childIndex = 0; childIndex < oldChildren.length; childIndex += 1) {
        if (!this.sameEntryKey(oldChildren[childIndex], newChildren[childIndex])) {
          sameKeys = false;
          break;
        }
        if (oldChildren[childIndex] !== newChildren[childIndex]) changedChildIndexes.push(childIndex);
      }
    }

    if (sameKeys) {
      for (const childIndex of changedChildIndexes) {
        const oldChild = oldChildren[childIndex];
        const newChild = newChildren[childIndex];
        this.updateEntry(
          oldChild,
          newChild,
          this.indexByPathKey.get(this.keyForEntry(newChild)) ?? -1,
          row.depth + 1,
          false,
          childIndex,
          newChildren.length,
          index,
          hideDotFiles,
        );
      }
      return;
    }

    let prefixLength = 0;
    while (prefixLength < oldChildren.length && prefixLength < newChildren.length) {
      if (!this.sameEntryKey(oldChildren[prefixLength], newChildren[prefixLength])) break;
      prefixLength += 1;
    }
    let suffixLength = 0;
    while (suffixLength < oldChildren.length - prefixLength && suffixLength < newChildren.length - prefixLength) {
      const oldIndex = oldChildren.length - suffixLength - 1;
      const newIndex = newChildren.length - suffixLength - 1;
      if (!this.sameEntryKey(oldChildren[oldIndex], newChildren[newIndex])) break;
      suffixLength += 1;
    }

    const firstOldChanged = prefixLength < oldChildren.length ? this.indexByPathKey.get(this.keyForEntry(oldChildren[prefixLength])) : undefined;
    const start = firstOldChanged ?? index + row.subtreeSize;
    const firstPreservedSuffix = suffixLength ? oldChildren.length - suffixLength : oldChildren.length;
    const end = firstPreservedSuffix < oldChildren.length
      ? this.indexByPathKey.get(this.keyForEntry(oldChildren[firstPreservedSuffix])) ?? start
      : index + row.subtreeSize;
    const insertedChildren = newChildren.slice(prefixLength, newChildren.length - suffixLength);
    const insertedRows = this.flattenChildren(
      insertedChildren,
      index,
      row.depth + 1,
      prefixLength,
      newChildren.length,
      hideDotFiles,
    );
    this.replaceFlatRange(index, start, end, insertedRows);
    this.setDirectChildSemantics(index, newChildren);

    for (let childIndex = 0; childIndex < prefixLength; childIndex += 1) {
      this.stats.directChildEntriesVisited += 1;
      const oldChild = oldChildren[childIndex];
      const newChild = newChildren[childIndex];
      if (oldChild === newChild) continue;
      this.updateEntry(
        oldChild,
        newChild,
        this.indexByPathKey.get(this.keyForEntry(newChild)) ?? -1,
        row.depth + 1,
        false,
        childIndex,
        newChildren.length,
        index,
        hideDotFiles,
      );
    }
    for (let offset = 0; offset < suffixLength; offset += 1) {
      this.stats.directChildEntriesVisited += 1;
      const oldIndex = oldChildren.length - suffixLength + offset;
      const newIndex = newChildren.length - suffixLength + offset;
      const oldChild = oldChildren[oldIndex];
      const newChild = newChildren[newIndex];
      if (oldChild === newChild) continue;
      this.updateEntry(
        oldChild,
        newChild,
        this.indexByPathKey.get(this.keyForEntry(newChild)) ?? -1,
        row.depth + 1,
        false,
        newIndex,
        newChildren.length,
        index,
        hideDotFiles,
      );
    }
  }

  private flattenChildren(
    children: readonly T[],
    parentIndex: number,
    depth: number,
    firstSiblingIndex: number,
    siblingCount: number,
    hideDotFiles: boolean,
  ): IndexedVisibleTreeRow<T>[] {
    const rows: IndexedVisibleTreeRow<T>[] = [];
    const pending: Array<{ entry: T; depth: number; siblingIndex: number; siblingCount: number; parentIndex: number }> = [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ entry: children[index], depth, siblingIndex: firstSiblingIndex + index, siblingCount, parentIndex: -1 });
    }

    while (pending.length) {
      const current = pending.pop();
      if (!current || (hideDotFiles && current.entry.name.startsWith("."))) continue;
      const index = rows.length;
      const row: IndexedVisibleTreeRow<T> = {
        entry: current.entry,
        depth: current.depth,
        isRoot: false,
        siblingIndex: current.siblingIndex,
        siblingCount: current.siblingCount,
        parentIndex: current.parentIndex,
        index,
        pathKey: this.keyForEntry(current.entry),
        subtreeSize: 1,
      };
      rows.push(row);
      this.stats.visibleEntriesFlattened += 1;

      if (current.entry.kind !== "directory" || !current.entry.expanded) continue;
      const visible = this.visibleChildren(current.entry, hideDotFiles);
      for (let childIndex = visible.length - 1; childIndex >= 0; childIndex -= 1) {
        pending.push({
          entry: visible[childIndex],
          depth: current.depth + 1,
          siblingIndex: childIndex,
          siblingCount: visible.length,
          parentIndex: index,
        });
      }
    }

    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row.parentIndex >= 0 && row.parentIndex < rows.length) rows[row.parentIndex].subtreeSize += row.subtreeSize;
    }
    return rows;
  }

  private replaceFlatRange(parentIndex: number, start: number, end: number, insertedRows: IndexedVisibleTreeRow<T>[]): void {
    const deleteCount = Math.max(0, end - start);
    const removed = this.rows.slice(start, end);
    for (const row of removed) {
      this.indexByPathKey.delete(row.pathKey);
      this.removedPathKeys.push(row.pathKey);
    }
    this.stats.rowsRemoved += removed.length;
    this.stats.rowsInserted += insertedRows.length;

    const delta = insertedRows.length - deleteCount;
    this.rows.splice(start, deleteCount, ...insertedRows);
    for (let offset = 0; offset < insertedRows.length; offset += 1) {
      const row = insertedRows[offset];
      row.index = start + offset;
      row.parentIndex = row.parentIndex < 0 ? parentIndex : row.parentIndex + start;
      this.indexByPathKey.set(row.pathKey, row.index);
      this.stats.indexMapWrites += 1;
      this.changedRows.add(row);
    }

    if (delta !== 0) {
      for (let rowIndex = start + insertedRows.length; rowIndex < this.rows.length; rowIndex += 1) {
        const row = this.rows[rowIndex];
        let changed = false;
        if (row.index !== rowIndex) {
          row.index = rowIndex;
          this.indexByPathKey.set(row.pathKey, rowIndex);
          this.stats.indexMapWrites += 1;
          this.stats.rowsShifted += 1;
          changed = true;
        }
        if (row.parentIndex >= end) {
          row.parentIndex += delta;
          changed = true;
        }
        if (changed) this.markChanged(row);
      }
      let ancestorIndex = parentIndex;
      while (ancestorIndex >= 0) {
        const ancestor = this.rows[ancestorIndex];
        ancestor.subtreeSize += delta;
        ancestorIndex = ancestor.parentIndex;
      }
    }
  }

  private setDirectChildSemantics(parentIndex: number, children: readonly T[]): void {
    this.stats.directChildEntriesVisited += children.length;
    for (let siblingIndex = 0; siblingIndex < children.length; siblingIndex += 1) {
      const index = this.indexByPathKey.get(this.keyForEntry(children[siblingIndex]));
      if (index === undefined) continue;
      const row = this.rows[index];
      let changed = false;
      if (row.siblingIndex !== siblingIndex) { row.siblingIndex = siblingIndex; changed = true; }
      if (row.siblingCount !== children.length) { row.siblingCount = children.length; changed = true; }
      if (row.parentIndex !== parentIndex) { row.parentIndex = parentIndex; changed = true; }
      if (changed) this.markChanged(row);
    }
  }

  private visibleChildren(entry: VirtualTreeEntry, hideDotFiles: boolean): readonly T[] {
    const children = entry.children ?? [];
    if (!hideDotFiles) return children as readonly T[];
    this.stats.directChildEntriesVisited += children.length;
    return children.filter((child) => !child.name.startsWith(".")) as T[];
  }

  private keyForEntry(entry: T): string {
    const cached = this.entryKeyCache.get(entry);
    if (cached?.path === entry.path) return cached.key;
    const key = this.keyForPath(entry.path);
    this.entryKeyCache.set(entry, { path: entry.path, key });
    return key;
  }

  private keyForPath(path: string): string {
    this.stats.pathKeysComputed += 1;
    return pathComparisonKey(path, this.pathOptions);
  }

  private sameEntryKey(left: T, right: T): boolean {
    this.stats.directChildEntriesCompared += 1;
    this.stats.directChildEntriesVisited += 1;
    return left === right || this.keyForEntry(left) === this.keyForEntry(right);
  }

  private markChanged(row: IndexedVisibleTreeRow<T>): void {
    this.changedRows.add(row);
  }

  private finishChange(): void {
    this.didChange = this.changedRows.size > 0 || this.removedPathKeys.length > 0;
    if (!this.didChange) return;
    this.currentVersion += 1;
    this.stats.rowsUpdated += this.changedRows.size;
  }
}

export type VirtualWindow = {
  start: number;
  end: number;
  totalHeight: number;
  scrollTop: number;
  maxScrollTop: number;
};

export function virtualTreeWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 6,
): VirtualWindow {
  const safeRowHeight = Math.max(1, rowHeight);
  const safeRowCount = Math.max(0, rowCount);
  const safeViewportHeight = Math.max(0, viewportHeight);
  const totalHeight = safeRowCount * safeRowHeight;
  const maxScrollTop = Math.max(0, totalHeight - safeViewportHeight);
  const clampedScrollTop = Math.min(Math.max(0, scrollTop), maxScrollTop);
  const safeOverscan = Math.max(0, Math.floor(overscan));
  const start = Math.max(0, Math.floor(clampedScrollTop / safeRowHeight) - safeOverscan);
  const end = Math.min(safeRowCount, Math.ceil((clampedScrollTop + safeViewportHeight) / safeRowHeight) + safeOverscan);

  return { start, end, totalHeight, scrollTop: clampedScrollTop, maxScrollTop };
}

function visibleChildren(entry: VirtualTreeEntry, hideDotFiles: boolean): VirtualTreeEntry[] {
  const children = entry.children ?? [];
  return hideDotFiles ? children.filter((child) => !child.name.startsWith(".")) : [...children];
}

function sameEntryPath<T extends VirtualTreeEntry & { path: string }>(
  left: T | undefined,
  right: T,
  keyForEntry: (entry: T) => string,
): boolean {
  return left !== undefined && keyForEntry(left) === keyForEntry(right);
}
