import { describe, expect, it } from "vitest";
import {
  GIT_HISTORY_OVERSCAN,
  GIT_HISTORY_ROW_HEIGHT,
  gitHistoryRenderWindow,
} from "./git-history-virtualization";

describe("Git history virtualization", () => {
  it.each([1000, 10000])("keeps %i loaded commits in a viewport-sized render window", (count) => {
    const viewportHeight = 540;
    const window = gitHistoryRenderWindow(count, 0, viewportHeight);

    expect(window.totalHeight).toBe(count * GIT_HISTORY_ROW_HEIGHT);
    expect(window.indexes.length).toBeLessThanOrEqual(
      Math.ceil(viewportHeight / GIT_HISTORY_ROW_HEIGHT) + GIT_HISTORY_OVERSCAN,
    );
    expect(window.indexes[0]).toBe(0);
    expect(window.indexes.at(-1)).toBeGreaterThan(0);
  });

  it("clamps a bottom scroll and retains one focused row outside the visible window", () => {
    const count = 10000;
    const viewportHeight = 440;
    const visibleWindow = gitHistoryRenderWindow(count, 0, viewportHeight);
    const focusedIndex = count - 1;
    const focusRetainedWindow = gitHistoryRenderWindow(count, 0, viewportHeight, focusedIndex);
    const bottomWindow = gitHistoryRenderWindow(
      count,
      count * GIT_HISTORY_ROW_HEIGHT,
      viewportHeight,
    );

    expect(bottomWindow.scrollTop).toBe(bottomWindow.maxScrollTop);
    expect(focusRetainedWindow.indexes).toContain(focusedIndex);
    expect(focusRetainedWindow.indexes.length).toBe(visibleWindow.indexes.length + 1);
    expect(focusRetainedWindow.indexes).toEqual([...focusRetainedWindow.indexes].sort((a, b) => a - b));
  });

  it("does not keep a focus row after its commit is filtered out", () => {
    const window = gitHistoryRenderWindow(20, 0, 220, 50);
    expect(window.indexes).not.toContain(50);
  });
});
