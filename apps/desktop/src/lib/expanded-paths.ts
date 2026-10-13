/**
 * Expanded-paths cache.
 *
 * Session checkpoints ask for the expanded directory paths on every debounce
 * tick. The directory tree is immutable (every update produces a new root
 * object), so caching the collected paths keyed by the root reference is
 * equivalent to an incremental update: any rebuild, relist or expand/collapse
 * produces a new root and therefore invalidates the cache automatically.
 * Results are kept per root so parked project trees stay cached while another
 * project is active.
 */
import type { DirectoryEntry } from "../types";

export type ExpandedPathsCache = {
  /** Returns the expanded paths for `root`, reusing the result collected for that root. */
  current(root: DirectoryEntry): string[];
  /** Forces the next `current` call to re-collect. */
  invalidate(): void;
};

export function createExpandedPathsCache(collect: (root: DirectoryEntry) => string[]): ExpandedPathsCache {
  let cache = new WeakMap<DirectoryEntry, string[]>();
  return {
    current(root: DirectoryEntry) {
      let paths = cache.get(root);
      if (!paths) {
        paths = collect(root);
        cache.set(root, paths);
      }
      return paths;
    },
    invalidate() {
      cache = new WeakMap();
    },
  };
}
