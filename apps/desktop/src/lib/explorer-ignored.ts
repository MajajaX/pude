import type { DirectoryEntry } from "../types";

export type ExplorerEntry = DirectoryEntry & { gitIgnoredGroup?: boolean };

export function loadedExplorerPaths(root: DirectoryEntry): string[] {
  const paths: string[] = [];
  const pending = [...(root.children ?? [])];
  while (pending.length) {
    const entry = pending.pop()!;
    paths.push(entry.path);
    if (entry.children) pending.push(...entry.children);
  }
  return paths;
}

export function groupIgnoredEntries(
  root: DirectoryEntry,
  isIgnored: (path: string) => boolean,
  expanded: boolean,
  hideDotFiles: boolean,
): ExplorerEntry {
  const ignored: DirectoryEntry[] = [];
  const children: DirectoryEntry[] = [];
  for (const entry of root.children ?? []) {
    if (isIgnored(entry.path)) ignored.push(entry);
    else children.push(entry);
  }
  if (!ignored.some((entry) => !hideDotFiles || !entry.name.startsWith("."))) return root;
  const group: ExplorerEntry = {
    name: "Git ignored",
    path: `pude://git-ignored/${encodeURIComponent(root.path)}`,
    kind: "directory",
    loaded: true,
    expanded,
    gitIgnoredGroup: true,
    children: ignored,
  };
  return { ...root, children: [...children, group] };
}
