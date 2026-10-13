export type DiffRow = {
  state: "context" | "changed" | "added" | "removed";
  left?: string;
  right?: string;
  leftNumber?: number;
  rightNumber?: number;
};

export type DiffParseResult = {
  rows: DiffRow[];
  truncated: boolean;
};

export type StackedDiffLine =
  | { kind: "context"; text: string; oldNumber?: number; newNumber?: number }
  | { kind: "removed"; label: "BEFORE"; text: string; oldNumber?: number; newNumber?: number }
  | { kind: "added"; label: "AFTER"; text: string; oldNumber?: number; newNumber?: number };

export const DIFF_PREVIEW_BUDGETS = {
  maxInputChars: 4 * 1024 * 1024,
  maxRows: 10_000,
} as const;

type StoredChangeLine = { text: string; number: number };

export function parseDiff(diff: string): DiffParseResult {
  const inputTruncated = diff.length > DIFF_PREVIEW_BUDGETS.maxInputChars;
  let source = diff.slice(0, DIFF_PREVIEW_BUDGETS.maxInputChars);
  if (inputTruncated && isHighSurrogate(source.charCodeAt(source.length - 1))) source = source.slice(0, -1);

  const rows: DiffRow[] = [];
  let truncated = inputTruncated;
  let cursor = 0;
  let lineStart = 0;
  let lineEnd = 0;
  let hasLine = false;
  let oldNumber = 0;
  let newNumber = 0;
  let hunk: { oldRemaining: number; newRemaining: number } | undefined;
  let skippingCombinedHunk = false;

  const advanceLine = (): boolean => {
    if (cursor >= source.length) {
      hasLine = false;
      return false;
    }
    lineStart = cursor;
    const newlineIndex = source.indexOf("\n", cursor);
    if (newlineIndex < 0) {
      cursor = source.length;
      if (inputTruncated) {
        hasLine = false;
        return false;
      }
      lineEnd = source.length;
    } else {
      cursor = newlineIndex + 1;
      lineEnd = newlineIndex;
    }
    if (lineEnd > lineStart && source.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
    hasLine = true;
    return true;
  };

  const lineStarts = (prefix: string): boolean => lineEnd - lineStart >= prefix.length && source.startsWith(prefix, lineStart);
  const lineText = (): string => source.slice(lineStart, lineEnd);
  const lineBody = (): string => source.slice(lineStart + 1, lineEnd);
  const countFromHeader = (value: string | undefined): number => Math.max(0, Number(value ?? "1"));
  const isHeader = (): boolean => lineStarts("diff ")
    || lineStarts("index ")
    || lineStarts("new file")
    || lineStarts("deleted file")
    || lineStarts("old mode")
    || lineStarts("new mode")
    || lineStarts("similarity index")
    || lineStarts("rename from")
    || lineStarts("rename to")
    || lineStarts("---")
    || lineStarts("+++")
    || lineStarts("\\");

  advanceLine();
  parse: while (hasLine) {
    if (lineStarts("@@@")) {
      hunk = undefined;
      skippingCombinedHunk = true;
      advanceLine();
      continue;
    }
    if (skippingCombinedHunk) {
      if (lineStarts("diff ")) {
        skippingCombinedHunk = false;
      } else if (lineStarts("@@ ")) {
        skippingCombinedHunk = false;
      } else {
        advanceLine();
        continue;
      }
    }

    if (lineStarts("@@")) {
      const match = lineText().match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      hunk = match ? { oldRemaining: countFromHeader(match[2]), newRemaining: countFromHeader(match[4]) } : undefined;
      oldNumber = match ? Number(match[1]) : 0;
      newNumber = match ? Number(match[3]) : 0;
      advanceLine();
      continue;
    }

    if (!hunk) {
      advanceLine();
      continue;
    }

    if (lineStarts(" ") && hunk.oldRemaining > 0 && hunk.newRemaining > 0) {
      if (rows.length >= DIFF_PREVIEW_BUDGETS.maxRows) {
        truncated = true;
        break parse;
      }
      const text = lineBody();
      rows.push({ state: "context", left: text, right: text, leftNumber: oldNumber, rightNumber: newNumber });
      oldNumber += 1;
      newNumber += 1;
      hunk.oldRemaining -= 1;
      hunk.newRemaining -= 1;
      advanceLine();
      continue;
    }

    const canStartRemoved = lineStarts("-") && hunk.oldRemaining > 0;
    const canStartAdded = lineStarts("+") && hunk.newRemaining > 0;
    if (canStartRemoved || canStartAdded) {
      const rowBudget = DIFF_PREVIEW_BUDGETS.maxRows - rows.length;
      if (rowBudget === 0) {
        truncated = true;
        break parse;
      }

      const removed: StoredChangeLine[] = [];
      const added: StoredChangeLine[] = [];
      let removedCount = 0;
      let addedCount = 0;

      while (hasLine && lineStarts("-") && hunk.oldRemaining > 0) {
        if (removedCount < rowBudget) removed.push({ text: lineBody(), number: oldNumber });
        removedCount += 1;
        oldNumber += 1;
        hunk.oldRemaining -= 1;
        advanceLine();
      }
      while (hasLine && lineStarts("+") && hunk.newRemaining > 0) {
        if (addedCount < rowBudget) added.push({ text: lineBody(), number: newNumber });
        addedCount += 1;
        newNumber += 1;
        hunk.newRemaining -= 1;
        advanceLine();
      }

      const pairCount = Math.max(removedCount, addedCount);
      const visibleCount = Math.min(rowBudget, pairCount);
      for (let offset = 0; offset < visibleCount; offset += 1) {
        const before = removed[offset];
        const after = added[offset];
        rows.push({
          state: before && after ? "changed" : before ? "removed" : "added",
          left: before?.text,
          right: after?.text,
          leftNumber: before?.number,
          rightNumber: after?.number,
        });
      }
      if (pairCount > rowBudget) {
        truncated = true;
        break parse;
      }
      continue;
    }

    if (!lineStarts("\\ No newline at end of file") && (isHeader() || lineStarts("Binary files"))) hunk = undefined;
    advanceLine();
  }

  return { rows, truncated };
}

export function toStackedDiffLines(rows: DiffRow[]): StackedDiffLine[] {
  const stacked: StackedDiffLine[] = [];
  const removed: StackedDiffLine[] = [];
  const added: StackedDiffLine[] = [];
  const flushChanges = () => {
    stacked.push(...removed, ...added);
    removed.length = 0;
    added.length = 0;
  };
  for (const row of rows) {
    if (row.state === "context") {
      flushChanges();
      const text = row.left ?? row.right;
      if (text !== undefined) stacked.push({ kind: "context", text, oldNumber: row.leftNumber, newNumber: row.rightNumber });
      continue;
    }

    if (row.left !== undefined) removed.push({ kind: "removed", label: "BEFORE", text: row.left, oldNumber: row.leftNumber });
    if (row.right !== undefined) added.push({ kind: "added", label: "AFTER", text: row.right, newNumber: row.rightNumber });
  }
  flushChanges();
  return stacked;
}

function isHighSurrogate(codeUnit: number | undefined): boolean {
  return codeUnit !== undefined && codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
