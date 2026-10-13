import { describe, expect, it } from "vitest";
import { DIFF_PREVIEW_BUDGETS, parseDiff, toStackedDiffLines } from "./diff";
import { virtualTreeWindow } from "./tree-virtualization";

const DIFF_ROW_HEIGHT = 22;
const DIFF_OVERSCAN = 8;
const BOUNDARY_COUNTS = [9_999, 10_000, 10_001, 20_000];

function changePatch(kind: "added" | "removed" | "replaced", count: number): string {
  const header = kind === "added"
    ? `@@ -0,0 +1,${count} @@`
    : kind === "removed"
      ? `@@ -1,${count} +0,0 @@`
      : `@@ -1,${count} +1,${count} @@`;
  const lines = [header];
  if (kind !== "added") for (let index = 0; index < count; index += 1) lines.push(`-old-${index + 1}`);
  if (kind !== "removed") for (let index = 0; index < count; index += 1) lines.push(`+new-${index + 1}`);
  return lines.join("\n");
}

describe("diff parser", () => {
  it("shows changed lines while hiding patch metadata", () => {
    const result = parseDiff([
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1234567..abcdef0 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -2,3 +2,3 @@ function run()",
      " keep();",
      "-before();",
      "+after();",
      " finish();",
      "\\ No newline at end of file",
    ].join("\n"));

    expect(result).toEqual({
      rows: [
        { state: "context", left: "keep();", right: "keep();", leftNumber: 2, rightNumber: 2 },
        { state: "changed", left: "before();", right: "after();", leftNumber: 3, rightNumber: 3 },
        { state: "context", left: "finish();", right: "finish();", leftNumber: 4, rightNumber: 4 },
      ],
      truncated: false,
    });
  });

  it("retains the visible prefix at every single-sided and paired row boundary", () => {
    for (const kind of ["added", "removed", "replaced"] as const) {
      for (const count of BOUNDARY_COUNTS) {
        const { rows, truncated } = parseDiff(changePatch(kind, count));
        const expectedLength = Math.min(count, DIFF_PREVIEW_BUDGETS.maxRows);
        expect(rows, `${kind} ${count}`).toHaveLength(expectedLength);
        expect(truncated, `${kind} ${count}`).toBe(count > DIFF_PREVIEW_BUDGETS.maxRows);
        expect(rows[0], `${kind} ${count} first row`).toMatchObject({
          state: kind === "added" ? "added" : kind === "removed" ? "removed" : "changed",
          left: kind === "added" ? undefined : "old-1",
          right: kind === "removed" ? undefined : "new-1",
          leftNumber: kind === "added" ? undefined : 1,
          rightNumber: kind === "removed" ? undefined : 1,
        });
        const last = rows.at(-1);
        const finalVisibleNumber = Math.min(count, DIFF_PREVIEW_BUDGETS.maxRows);
        expect(last?.leftNumber).toBe(kind === "added" ? undefined : finalVisibleNumber);
        expect(last?.rightNumber).toBe(kind === "removed" ? undefined : finalVisibleNumber);
        expect(last?.left).toBe(kind === "added" ? undefined : `old-${finalVisibleNumber}`);
        expect(last?.right).toBe(kind === "removed" ? undefined : `new-${finalVisibleNumber}`);
      }
    }
  });

  it("counts a removed plus added replacement as one paired row", () => {
    const paired = parseDiff(changePatch("replaced", 10_000));
    expect(paired.rows).toHaveLength(10_000);
    expect(paired.truncated).toBe(false);
    expect(toStackedDiffLines(paired.rows)).toHaveLength(20_000);
  });

  it("shows context once and labels each old/new line in stacked mode", () => {
    const { rows } = parseDiff(["@@ -1,3 +1,3 @@", " before();", "-old();", "+new();", " after();"].join("\n"));
    expect(toStackedDiffLines(rows)).toEqual([
      { kind: "context", text: "before();", oldNumber: 1, newNumber: 1 },
      { kind: "removed", label: "BEFORE", text: "old();", oldNumber: 2 },
      { kind: "added", label: "AFTER", text: "new();", newNumber: 2 },
      { kind: "context", text: "after();", oldNumber: 3, newNumber: 3 },
    ]);
  });

  it("keeps a removed block before additions in stacked mode", () => {
    const { rows } = parseDiff(["@@ -8,4 +8,5 @@", " before", "-old one", "-old two", "+new one", "+new two", "+new three", " after"].join("\n"));
    expect(toStackedDiffLines(rows)).toEqual([
      { kind: "context", text: "before", oldNumber: 8, newNumber: 8 },
      { kind: "removed", label: "BEFORE", text: "old one", oldNumber: 9 },
      { kind: "removed", label: "BEFORE", text: "old two", oldNumber: 10 },
      { kind: "added", label: "AFTER", text: "new one", newNumber: 9 },
      { kind: "added", label: "AFTER", text: "new two", newNumber: 10 },
      { kind: "added", label: "AFTER", text: "new three", newNumber: 11 },
      { kind: "context", text: "after", oldNumber: 11, newNumber: 12 },
    ]);
  });

  it("keeps the parsed context and the remaining paired prefix when a change exceeds the cap", () => {
    const lines = ["@@ -1,10001 +1,10001 @@", " leading-context"];
    for (let index = 0; index < 10_000; index += 1) lines.push(`-old-${index + 1}`);
    for (let index = 0; index < 10_000; index += 1) lines.push(`+new-${index + 1}`);
    const result = parseDiff(lines.join("\n"));
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(10_000);
    expect(result.rows[0]).toEqual({ state: "context", left: "leading-context", right: "leading-context", leftNumber: 1, rightNumber: 1 });
    expect(result.rows[1]).toEqual({ state: "changed", left: "old-1", right: "new-1", leftNumber: 2, rightNumber: 2 });
    expect(result.rows.at(-1)).toEqual({ state: "changed", left: "old-9999", right: "new-9999", leftNumber: 10_000, rightNumber: 10_000 });
  });

  it("pairs unequal change runs and preserves rows that have only one side", () => {
    const removedMore = parseDiff(["@@ -4,3 +4,1 @@", "-old one", "-old two", "-old three", "+new one"].join("\n"));
    expect(removedMore.rows).toEqual([
      { state: "changed", left: "old one", right: "new one", leftNumber: 4, rightNumber: 4 },
      { state: "removed", left: "old two", leftNumber: 5 },
      { state: "removed", left: "old three", leftNumber: 6 },
    ]);
    const addedMore = parseDiff(["@@ -4,1 +4,3 @@", "-old one", "+new one", "+new two", "+new three"].join("\n"));
    expect(addedMore.rows).toEqual([
      { state: "changed", left: "old one", right: "new one", leftNumber: 4, rightNumber: 4 },
      { state: "added", right: "new two", rightNumber: 5 },
      { state: "added", right: "new three", rightNumber: 6 },
    ]);
  });

  it("continues after a combined hunk and keeps binary, metadata, and following files safe", () => {
    const result = parseDiff([
      "diff --cc src/combined.ts",
      "index 1234567,abcdef0..7654321",
      "@@@ -1,1 -1,1 +1,1 @@@",
      "--from-parent();",
      "++combined();",
      "diff --git a/image.bin b/image.bin",
      "Binary files a/image.bin and b/image.bin differ",
      "diff --git a/src/regular.ts b/src/regular.ts",
      "index 1234567..abcdef0 100644",
      "--- a/src/regular.ts",
      "+++ b/src/regular.ts",
      "@@ -1 +1 @@",
      "-old();",
      "+new();",
    ].join("\n"));

    expect(result.rows).toEqual([{ state: "changed", left: "old();", right: "new();", leftNumber: 1, rightNumber: 1 }]);
    expect(result.truncated).toBe(false);
  });

  it("preserves CRLF lines and an unterminated final patch line", () => {
    expect(parseDiff("@@ -1,1 +1,1 @@\r\n-old\r\n+new")).toEqual({
      rows: [{ state: "changed", left: "old", right: "new", leftNumber: 1, rightNumber: 1 }],
      truncated: false,
    });
  });

  it("does not parse a partial line cut by the character limit", () => {
    const prefix = "@@ -0,0 +1,1 @@\n+kept\n";
    const diff = `${prefix}${"metadata".padEnd(DIFF_PREVIEW_BUDGETS.maxInputChars - prefix.length, "x")}+hidden\n`;
    const result = parseDiff(diff);
    expect(result.truncated).toBe(true);
    expect(result.rows).toEqual([{ state: "added", right: "kept", rightNumber: 1 }]);
  });

  it("windows the capped rows to the viewport without changing the retained prefix", () => {
    const { rows, truncated } = parseDiff(changePatch("replaced", 10_001));
    expect(truncated).toBe(true);
    expect(rows).toHaveLength(10_000);

    const viewportHeight = 540;
    const topWindow = virtualTreeWindow(rows.length, 0, viewportHeight, DIFF_ROW_HEIGHT, DIFF_OVERSCAN);
    const bottomWindow = virtualTreeWindow(rows.length, rows.length * DIFF_ROW_HEIGHT, viewportHeight, DIFF_ROW_HEIGHT, DIFF_OVERSCAN);
    const expectedSize = Math.ceil(viewportHeight / DIFF_ROW_HEIGHT) + 2 * DIFF_OVERSCAN;

    expect(topWindow.end - topWindow.start).toBeLessThanOrEqual(expectedSize);
    expect(bottomWindow.end - bottomWindow.start).toBeLessThanOrEqual(expectedSize);
    expect(topWindow.end - topWindow.start).toBe(bottomWindow.end - bottomWindow.start);
    expect(bottomWindow.end).toBe(rows.length);
    expect(virtualTreeWindow(0, 0, viewportHeight, DIFF_ROW_HEIGHT, DIFF_OVERSCAN)).toMatchObject({ start: 0, end: 0, totalHeight: 0 });
  });
});
