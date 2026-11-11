import type { VirtualTreeEntry, VisibleTreeRow } from "./tree-virtualization";
import { isWorkspaceRootEntry } from "./workspace-folders";

/**
 * An independent full flattening, kept apart from VisibleTreeModel so tests can
 * compare the model's incremental updates against a plain rebuild.
 */
export function flattenVisibleTree<T extends VirtualTreeEntry>(root: T, hideDotFiles: boolean): VisibleTreeRow<T>[] {
  const rows: VisibleTreeRow<T>[] = [];
  const visit = (entry: T, depth: number, siblingIndex: number, siblingCount: number, parentIndex: number) => {
    const index = rows.length;
    rows.push({ entry, depth, isRoot: depth === 0, siblingIndex, siblingCount, parentIndex });
    if (entry.kind !== "directory" || !entry.expanded) return;
    const children = (entry.children ?? []) as readonly T[];
    const visible =
      hideDotFiles && !isWorkspaceRootEntry(entry as T & { path: string })
        ? children.filter((child) => !child.name.startsWith("."))
        : children;
    visible.forEach((child, childIndex) => {
      visit(child, depth + 1, childIndex, visible.length, index);
    });
  };
  visit(root, 0, 0, 1, -1);
  return rows;
}
