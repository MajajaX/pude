import { limitIo, withBusyRetry } from "./io-limiter";
import type { DirectoryEntry, DirectoryListResult } from "../types";
import { pathComparisonKey, runtimePathOptions } from "./path-identity";

export type DirectoryRestoreOptions = {
  root: DirectoryEntry;
  expandedPaths: ReadonlySet<string>;
  listDirectory: (path: string) => Promise<DirectoryListResult>;
  isCurrent: () => boolean;
  onTree: (tree: DirectoryEntry, depth: number) => void;
  maxConcurrent?: number;
};

export type DirectoryRestoreResult = {
  tree: DirectoryEntry;
  applied: boolean;
  interrupted: boolean;
};

export async function restoreDirectoryTreeByLevel(options: DirectoryRestoreOptions): Promise<DirectoryRestoreResult> {
  const maxConcurrent = Number.isFinite(options.maxConcurrent) ? Math.max(1, Math.floor(options.maxConcurrent ?? 1)) : 6;
  let tree = options.root;
  if (!options.isCurrent()) return { tree, applied: false, interrupted: true };
  options.onTree(tree, 0);

  let level = directoriesToLoad(tree, options.expandedPaths, true);
  let depth = 1;
  while (level.length) {
    if (!options.isCurrent()) return { tree, applied: false, interrupted: true };
    const loaded = await mapWithConcurrency(level, maxConcurrent, async (entry) => {
      try {
        // Directory restores share the global IO limiter and retry a busy native queue.
        const listing = await limitIo(() => withBusyRetry(() => options.listDirectory(entry.path)));
        return { path: entry.path, listing, failed: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unable to read directory.";
        return { path: entry.path, listing: { entries: [], partialError: { kind: "metadata" as const, message } }, failed: true };
      }
    });
    if (!options.isCurrent()) return { tree, applied: false, interrupted: true };

    let changed = false;
    for (const result of loaded) {
      tree = replaceDirectory(tree, result.path, (entry) => ({
        ...entry,
        children: result.listing?.entries,
        loaded: !result.failed,
        stale: result.failed,
        partialError: result.listing?.partialError ?? undefined,
        incomplete: result.listing?.incomplete ?? (result.listing?.stopReason != null ? true : undefined),
        listingStopReason: result.listing?.stopReason ?? undefined,
        expanded: true,
      }));
      changed = true;
    }
    if (changed) options.onTree(tree, depth);
    level = loaded.flatMap((result) => result.listing?.entries ? directoriesToLoad({ name: "level", path: result.path, kind: "directory", children: result.listing.entries, loaded: true }, options.expandedPaths, false) : []);
    depth += 1;
  }
  return { tree, applied: true, interrupted: false };
}

function directoriesToLoad(entry: DirectoryEntry, expandedPaths: ReadonlySet<string>, includeSelf: boolean): DirectoryEntry[] {
  const result: DirectoryEntry[] = [];
  if (includeSelf && entry.kind === "directory" && expandedPaths.has(pathKey(entry.path)) && (!entry.loaded || !entry.children)) result.push(entry);
  for (const child of entry.children ?? []) {
    if (child.kind === "directory" && expandedPaths.has(pathKey(child.path))) {
      if (!child.loaded || !child.children) result.push(child);
      else result.push(...directoriesToLoad(child, expandedPaths, false));
    }
  }
  return result;
}

function replaceDirectory(entry: DirectoryEntry, path: string, update: (entry: DirectoryEntry) => DirectoryEntry): DirectoryEntry {
  if (pathKey(entry.path) === pathKey(path)) return update(entry);
  if (!entry.children?.length) return entry;
  let changed = false;
  const children = entry.children.map((child) => {
    const next = replaceDirectory(child, path, update);
    changed ||= next !== child;
    return next;
  });
  return changed ? { ...entry, children } : entry;
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function pathKey(path: string): string {
  return pathComparisonKey(path, runtimePathOptions());
}
