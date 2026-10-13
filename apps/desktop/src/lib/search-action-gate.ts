/**
 * Consume each globally numbered search action once for its target tab. The
 * scalar high-water mark rejects delayed replays after a tab key is released;
 * the per-tab map is pruned as soon as a target closes.
 */
export function createSearchActionGate() {
  const lastConsumedByTab = new Map<string, number>();
  let highWaterMark = 0;

  const consume = (tabId: string, actionId: number): boolean => {
    if (!tabId || !Number.isSafeInteger(actionId) || actionId <= 0) return false;
    if (actionId <= highWaterMark || actionId <= (lastConsumedByTab.get(tabId) ?? 0)) return false;
    lastConsumedByTab.set(tabId, actionId);
    highWaterMark = actionId;
    return true;
  };

  const releaseClosedTabs = (openTabIds: readonly string[]) => {
    const openTabs = new Set(openTabIds);
    for (const tabId of lastConsumedByTab.keys()) {
      if (!openTabs.has(tabId)) lastConsumedByTab.delete(tabId);
    }
  };

  return {
    consume,
    releaseClosedTabs,
    getTrackedTabCount: () => lastConsumedByTab.size,
  };
}
