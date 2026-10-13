import type { GitFileStatus } from "../types";

export type GitStatusGroup = "staged" | "changes";

export type GitStatusRow =
  | { kind: "header"; key: string; group: GitStatusGroup; label: string; count: number }
  | { kind: "file"; key: string; group: GitStatusGroup; file: GitFileStatus; staged: boolean };

export const GIT_STATUS_HEADER_HEIGHT = 27;
export const GIT_STATUS_FILE_ROW_HEIGHT = 28;

export function buildGitStatusRows(files: readonly GitFileStatus[]): GitStatusRow[] {
  const staged = files.filter((file) => !file.conflict && file.indexStatus && file.indexStatus !== ".");
  const changes = files.filter((file) => file.conflict || !file.indexStatus || file.worktreeStatus);
  const rows: GitStatusRow[] = [];
  if (staged.length) {
    rows.push({ kind: "header", key: "header:staged", group: "staged", label: "STAGED CHANGES", count: staged.length });
    for (const file of staged) rows.push({ kind: "file", key: `staged:${file.path}`, group: "staged", file, staged: true });
  }
  if (changes.length) {
    rows.push({ kind: "header", key: "header:changes", group: "changes", label: "CHANGES", count: changes.length });
    for (const file of changes) rows.push({ kind: "file", key: `changes:${file.path}`, group: "changes", file, staged: false });
  }
  return rows;
}

export function gitStatusRowHeight(row: GitStatusRow): number {
  return row.kind === "header" ? GIT_STATUS_HEADER_HEIGHT : GIT_STATUS_FILE_ROW_HEIGHT;
}

export type GitStatusLayout = {
  offsets: number[];
  totalHeight: number;
};

export function layoutGitStatusRows(rows: readonly GitStatusRow[]): GitStatusLayout {
  const offsets: number[] = new Array(rows.length);
  let top = 0;
  for (let index = 0; index < rows.length; index += 1) {
    offsets[index] = top;
    top += gitStatusRowHeight(rows[index]);
  }
  return { offsets, totalHeight: top };
}

export type GitStatusWindow = {
  start: number;
  end: number;
  totalHeight: number;
  scrollTop: number;
  maxScrollTop: number;
};

export function gitStatusWindow(
  rows: readonly GitStatusRow[],
  layout: GitStatusLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan = 8,
): GitStatusWindow {
  const rowCount = rows.length;
  const totalHeight = layout.totalHeight;
  const safeViewportHeight = Math.max(0, viewportHeight);
  const maxScrollTop = Math.max(0, totalHeight - safeViewportHeight);
  const clampedScrollTop = Math.min(Math.max(0, scrollTop), maxScrollTop);
  const safeOverscan = Math.max(0, Math.floor(overscan));
  const viewportBottom = clampedScrollTop + safeViewportHeight;

  if (!rowCount) return { start: 0, end: 0, totalHeight, scrollTop: clampedScrollTop, maxScrollTop };

  // Row bottom edges are strictly increasing, so both predicates are monotone
  // and searchable with a binary search.
  let low = 0;
  let high = rowCount - 1;
  let firstVisible = rowCount;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const bottom = layout.offsets[mid] + gitStatusRowHeight(rows[mid]);
    if (bottom > clampedScrollTop) {
      firstVisible = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  low = 0;
  high = rowCount;
  let firstBelow = rowCount;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (layout.offsets[mid] >= viewportBottom) {
      firstBelow = mid;
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  const start = Math.max(0, firstVisible - safeOverscan);
  const end = Math.min(rowCount, firstBelow + safeOverscan);
  return { start, end: Math.max(end, start), totalHeight, scrollTop: clampedScrollTop, maxScrollTop };
}

export function clampGitStatusIndex(index: number, rowCount: number): number {
  if (rowCount <= 0) return -1;
  return Math.min(Math.max(0, Math.floor(index)), rowCount - 1);
}

export function resolveGitStatusFocus(
  previousKey: string | undefined,
  previousIndex: number,
  rows: readonly GitStatusRow[],
): { key: string; index: number } | undefined {
  if (!rows.length) return undefined;
  if (previousKey) {
    const index = rows.findIndex((row) => row.key === previousKey);
    if (index >= 0) return { key: previousKey, index };
  }
  const clamped = clampGitStatusIndex(previousIndex, rows.length);
  for (let offset = 0; offset < rows.length; offset += 1) {
    const before = clamped - offset;
    if (before >= 0 && rows[before].kind === "file") return { key: rows[before].key, index: before };
    const after = clamped + offset;
    if (after < rows.length && rows[after].kind === "file") return { key: rows[after].key, index: after };
  }
  return { key: rows[clamped].key, index: clamped };
}
