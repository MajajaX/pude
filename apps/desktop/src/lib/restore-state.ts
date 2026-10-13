import type { PersistedTab } from "./session-storage";
import { pathComparisonKey, runtimePathOptions } from "./path-identity";

export type RestoreIntent = {
  generation: number;
  pendingTabIds: ReadonlySet<string>;
  cancelledTabIds: ReadonlySet<string>;
  openedPaths: ReadonlySet<string>;
};

type MutableRestoreIntent = {
  generation: number;
  pendingTabIds: Set<string>;
  cancelledTabIds: Set<string>;
  openedPaths: Set<string>;
};

export function createRestoreIntent(tabs: readonly PersistedTab[], generation: number): RestoreIntent {
  return toReadonly({
    generation,
    pendingTabIds: new Set(tabs.map((tab) => tab.id)),
    cancelledTabIds: new Set(),
    openedPaths: new Set(),
  });
}

export function markRestoreTabStarted(intent: RestoreIntent, tabId: string): RestoreIntent {
  const next = mutableCopy(intent);
  next.pendingTabIds.delete(tabId);
  return toReadonly(next);
}

export function markRestoreTabCancelled(intent: RestoreIntent, tabId: string): RestoreIntent {
  const next = mutableCopy(intent);
  next.pendingTabIds.delete(tabId);
  next.cancelledTabIds.add(tabId);
  return toReadonly(next);
}

export function markUserOpenedPath(intent: RestoreIntent, path: string): RestoreIntent {
  const next = mutableCopy(intent);
  next.openedPaths.add(pathKey(path));
  return toReadonly(next);
}

export function shouldMergeRestoredTab(intent: RestoreIntent, persistedTab: PersistedTab, currentTabIds: ReadonlySet<string>): boolean {
  if (intent.cancelledTabIds.has(persistedTab.id) || currentTabIds.has(persistedTab.id)) return false;
  return !intent.openedPaths.has(pathKey(persistedTab.path));
}

function mutableCopy(intent: RestoreIntent): MutableRestoreIntent {
  return {
    generation: intent.generation,
    pendingTabIds: new Set(intent.pendingTabIds),
    cancelledTabIds: new Set(intent.cancelledTabIds),
    openedPaths: new Set(intent.openedPaths),
  };
}

function toReadonly(intent: MutableRestoreIntent): RestoreIntent {
  return intent;
}

function pathKey(path: string): string {
  return pathComparisonKey(path, runtimePathOptions());
}
