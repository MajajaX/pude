import { describe, expect, it } from "vitest";
import {
  GIT_STATUS_FILE_ROW_HEIGHT,
  GIT_STATUS_HEADER_HEIGHT,
  buildGitStatusRows,
  gitStatusRowHeight,
  gitStatusWindow,
  layoutGitStatusRows,
  resolveGitStatusFocus,
} from "./git-status-virtualization";
import type { GitFileStatus } from "../types";

function file(path: string, overrides: Partial<GitFileStatus> = {}): GitFileStatus {
  return { path, indexStatus: null, worktreeStatus: "M", ...overrides };
}

function untrackedFiles(count: number): GitFileStatus[] {
  return Array.from({ length: count }, (_, index) => file(`src/generated-${index}.ts`, { indexStatus: null, worktreeStatus: "?" }));
}

describe("git status virtualization", () => {
  it("builds grouped rows with stable group+path keys", () => {
    const rows = buildGitStatusRows([
      file("src/staged.ts", { indexStatus: "M", worktreeStatus: null }),
      file("src/changed.ts", { indexStatus: null, worktreeStatus: "M" }),
    ]);

    expect(rows.map((row) => row.key)).toEqual([
      "header:staged",
      "staged:src/staged.ts",
      "header:changes",
      "changes:src/changed.ts",
    ]);
    expect(rows[0]).toMatchObject({ kind: "header", label: "STAGED CHANGES", count: 1 });
    expect(rows[2]).toMatchObject({ kind: "header", label: "CHANGES", count: 1 });

    const rebuilt = buildGitStatusRows([
      file("src/staged.ts", { indexStatus: "M", worktreeStatus: null }),
      file("src/changed.ts", { indexStatus: null, worktreeStatus: "M" }),
    ]);
    expect(rebuilt.map((row) => row.key)).toEqual(rows.map((row) => row.key));
  });

  it("keeps the same file in both groups when it is staged and unstaged at once", () => {
    const rows = buildGitStatusRows([file("src/both.ts", { indexStatus: "M", worktreeStatus: "M" })]);
    expect(rows.map((row) => row.key)).toEqual([
      "header:staged",
      "staged:src/both.ts",
      "header:changes",
      "changes:src/both.ts",
    ]);
  });

  it("omits empty groups and produces no rows for a clean tree", () => {
    expect(buildGitStatusRows([])).toEqual([]);
    const onlyStaged = buildGitStatusRows([file("a.ts", { indexStatus: "A", worktreeStatus: null })]);
    expect(onlyStaged.map((row) => row.key)).toEqual(["header:staged", "staged:a.ts"]);
  });

  it.each([1000, 10000])("keeps the rendered window bounded for %i untracked files", (count) => {
    const rows = buildGitStatusRows(untrackedFiles(count));
    const layout = layoutGitStatusRows(rows);
    const viewportHeight = 540;
    const window = gitStatusWindow(rows, layout, 0, viewportHeight, 8);

    expect(rows).toHaveLength(count + 1);
    expect(layout.totalHeight).toBe(GIT_STATUS_HEADER_HEIGHT + count * GIT_STATUS_FILE_ROW_HEIGHT);
    expect(window.end - window.start).toBeLessThanOrEqual(Math.ceil(viewportHeight / GIT_STATUS_FILE_ROW_HEIGHT) + 2 * 8 + 1);
    expect(window.end - window.start).toBeGreaterThan(0);
  });

  it("renders a window whose size depends on the viewport, not the total row count", () => {
    const smallRows = buildGitStatusRows(untrackedFiles(1000));
    const largeRows = buildGitStatusRows(untrackedFiles(10000));
    const smallWindow = gitStatusWindow(smallRows, layoutGitStatusRows(smallRows), 0, 400, 8);
    const largeWindow = gitStatusWindow(largeRows, layoutGitStatusRows(largeRows), 0, 400, 8);

    expect(largeWindow.end - largeWindow.start).toBe(smallWindow.end - smallWindow.start);
    expect(largeWindow.end - largeWindow.start).toBeLessThan(40);
  });

  it("tracks mixed header and file heights in offsets and clamps scroll at the bottom", () => {
    const rows = buildGitStatusRows([
      file("a.ts", { indexStatus: "M", worktreeStatus: null }),
      file("b.ts", { indexStatus: null, worktreeStatus: "M" }),
    ]);
    const layout = layoutGitStatusRows(rows);

    expect(layout.offsets).toEqual([0, GIT_STATUS_HEADER_HEIGHT, GIT_STATUS_HEADER_HEIGHT + GIT_STATUS_FILE_ROW_HEIGHT, GIT_STATUS_HEADER_HEIGHT + GIT_STATUS_FILE_ROW_HEIGHT + GIT_STATUS_HEADER_HEIGHT]);
    expect(rows.map(gitStatusRowHeight)).toEqual([32, 30, 32, 30]);

    const window = gitStatusWindow(rows, layout, 999999, 100, 8);
    expect(window.scrollTop).toBe(window.maxScrollTop);
    expect(window.end).toBe(rows.length);
  });

  it("returns an empty window for empty rows", () => {
    const window = gitStatusWindow([], layoutGitStatusRows([]), 100, 400, 8);
    expect(window).toMatchObject({ start: 0, end: 0, totalHeight: 0, scrollTop: 0, maxScrollTop: 0 });
  });

  it("keeps focus on the same row when it survives a list update", () => {
    const before = buildGitStatusRows([
      file("a.ts", { indexStatus: null, worktreeStatus: "M" }),
      file("b.ts", { indexStatus: null, worktreeStatus: "M" }),
    ]);
    const after = buildGitStatusRows([
      file("new.ts", { indexStatus: null, worktreeStatus: "?" }),
      file("a.ts", { indexStatus: null, worktreeStatus: "M" }),
      file("b.ts", { indexStatus: null, worktreeStatus: "M" }),
    ]);

    const resolved = resolveGitStatusFocus("changes:a.ts", 1, after);
    expect(resolved).toEqual({ key: "changes:a.ts", index: 2 });
    expect(before[1].key).toBe("changes:a.ts");
  });

  it("moves focus to a nearby file row when the focused row disappears", () => {
    const before = buildGitStatusRows([
      file("a.ts", { indexStatus: null, worktreeStatus: "M" }),
      file("b.ts", { indexStatus: null, worktreeStatus: "M" }),
      file("c.ts", { indexStatus: null, worktreeStatus: "M" }),
    ]);
    const after = buildGitStatusRows([
      file("a.ts", { indexStatus: null, worktreeStatus: "M" }),
      file("c.ts", { indexStatus: null, worktreeStatus: "M" }),
    ]);

    const focusIndexB = before.findIndex((row) => row.key === "changes:b.ts");
    const resolved = resolveGitStatusFocus("changes:b.ts", focusIndexB, after);
    expect(resolved).toBeDefined();
    expect(resolved!.key).not.toBe("changes:b.ts");
    expect(after[resolved!.index].kind).toBe("file");
    expect(Math.abs(resolved!.index - focusIndexB)).toBeLessThanOrEqual(1);
  });

  it("clamps focus migration to the last available row and clears focus on an empty list", () => {
    const rows = buildGitStatusRows([file("only.ts", { indexStatus: null, worktreeStatus: "M" })]);
    expect(resolveGitStatusFocus("changes:gone.ts", 500, rows)).toEqual({ key: "changes:only.ts", index: 1 });
    expect(resolveGitStatusFocus("changes:gone.ts", 0, [])).toBeUndefined();
  });
});
