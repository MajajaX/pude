import { virtualTreeWindow } from "./tree-virtualization";

export const GIT_HISTORY_ROW_HEIGHT = 44;
export const GIT_HISTORY_FULL_ROW_HEIGHT = 30;
export const GIT_HISTORY_OVERSCAN = 8;
/** The next page starts loading when this many loaded rows remain below the viewport. */
export const GIT_HISTORY_PREFETCH_ROWS = 40;

export type GitHistoryRenderWindow = ReturnType<typeof virtualTreeWindow> & {
  indexes: number[];
};

export function gitHistoryRenderWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  focusedIndex = -1,
  rowHeight = GIT_HISTORY_ROW_HEIGHT,
): GitHistoryRenderWindow {
  const window = virtualTreeWindow(
    rowCount,
    scrollTop,
    viewportHeight,
    rowHeight,
    GIT_HISTORY_OVERSCAN,
  );
  const indexes = Array.from(
    { length: window.end - window.start },
    (_, offset) => window.start + offset,
  );

  if (focusedIndex >= 0 && focusedIndex < rowCount && !indexes.includes(focusedIndex)) {
    indexes.push(focusedIndex);
    indexes.sort((left, right) => left - right);
  }

  return { ...window, indexes };
}

/** Whether two windows render the same rows, so scrolling within a row changes nothing. */
export function sameGitHistoryRenderWindow(left: GitHistoryRenderWindow, right: GitHistoryRenderWindow): boolean {
  return left.indexes.length === right.indexes.length
    && left.indexes.every((index, position) => index === right.indexes[position]);
}
