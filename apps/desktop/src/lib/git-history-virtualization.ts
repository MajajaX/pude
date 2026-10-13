import { virtualTreeWindow } from "./tree-virtualization";

export const GIT_HISTORY_ROW_HEIGHT = 44;
export const GIT_HISTORY_OVERSCAN = 8;

export type GitHistoryRenderWindow = ReturnType<typeof virtualTreeWindow> & {
  indexes: number[];
};

export function gitHistoryRenderWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  focusedIndex = -1,
): GitHistoryRenderWindow {
  const window = virtualTreeWindow(
    rowCount,
    scrollTop,
    viewportHeight,
    GIT_HISTORY_ROW_HEIGHT,
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
