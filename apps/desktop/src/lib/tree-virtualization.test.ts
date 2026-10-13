import { describe, expect, it } from "vitest";
import { flattenVisibleTree, treeKeyboardAction, virtualTreeWindow, VisibleTreeModel, type VirtualTreeEntry } from "./tree-virtualization";

function makeFlatTree(count: number): VirtualTreeEntry {
  return {
    name: "workspace",
    kind: "directory",
    expanded: true,
    children: Array.from({ length: count }, (_, index) => ({ name: `file-${index}.ts`, kind: "file" as const })),
  };
}

describe("tree virtualization", () => {
  it("keeps expanded and hidden tree behavior while assigning sibling semantics", () => {
    const root = {
      name: "workspace",
      kind: "directory" as const,
      expanded: true,
      children: [
        { name: "visible.ts", kind: "file" as const },
        { name: ".hidden.ts", kind: "file" as const },
        { name: "src", kind: "directory" as const, expanded: true, children: [{ name: "main.ts", kind: "file" as const }] },
      ],
    };

    const rows = flattenVisibleTree(root, true);
    expect(rows.map((row) => row.entry.name)).toEqual(["workspace", "visible.ts", "src", "main.ts"]);
    expect(rows.map((row) => [row.depth, row.siblingIndex, row.siblingCount])).toEqual([
      [0, 0, 1],
      [1, 0, 2],
      [1, 1, 2],
      [2, 0, 1],
    ]);
  });

  it.each([1000, 10000])("flattens %i visible rows and renders a bounded window", (count) => {
    const rows = flattenVisibleTree(makeFlatTree(count), false);
    const viewport = virtualTreeWindow(rows.length, rows.length * 27 + 1000, 540, 27, 8);

    expect(rows).toHaveLength(count + 1);
    expect(viewport.end - viewport.start).toBeLessThanOrEqual(29);
    expect(viewport.scrollTop).toBe(viewport.maxScrollTop);
    expect(viewport.totalHeight).toBe((count + 1) * 27);
  });

  it("clamps scroll after a collapse reduces total height", () => {
    const viewport = virtualTreeWindow(2, 900, 100, 27, 4);
    expect(viewport.scrollTop).toBe(0);
    expect(viewport.maxScrollTop).toBe(0);
    expect(viewport.start).toBe(0);
  });
});

describe("incremental visible tree model", () => {
  interface PathEntry extends VirtualTreeEntry {
    path: string;
    size?: number;
    children?: PathEntry[];
  }
  const modelOptions = { platform: "posix" as const, casePolicy: "sensitive" as const };

  function makeIndexedFlatTree(count: number): PathEntry {
    return {
      path: "/repo",
      name: "repo",
      kind: "directory",
      expanded: true,
      children: Array.from({ length: count }, (_, index) => ({
        path: `/repo/file-${index}.ts`,
        name: `file-${index}.ts`,
        kind: "file" as const,
      })),
    };
  }

  function comparable(rows: readonly ReturnType<typeof flattenVisibleTree<PathEntry>>[number][]) {
    return rows.map((row, index) => ({
      path: row.entry.path,
      depth: row.depth,
      isRoot: row.isRoot,
      siblingIndex: row.siblingIndex,
      siblingCount: row.siblingCount,
      parentIndex: row.parentIndex,
      index,
    }));
  }

  function expectModelMatches(model: VisibleTreeModel<PathEntry>, root: PathEntry, hideDotFiles: boolean): void {
    const reference = flattenVisibleTree(root, hideDotFiles);
    expect(comparable(model.rows)).toEqual(comparable(reference));
    for (let index = 0; index < model.rows.length; index += 1) {
      expect(model.indexOfPath(model.rows[index].entry.path)).toBe(index);
    }
    expect(model.indexOfPath("/missing")).toBe(-1);
  }

  it("matches the full-flatten reference after expand, collapse, insert, delete, and hide changes", () => {
    const source: PathEntry = {
      path: "/repo", name: "repo", kind: "directory", expanded: true,
      children: [
        { path: "/repo/src", name: "src", kind: "directory", expanded: false },
        { path: "/repo/readme.md", name: "readme.md", kind: "file" },
      ],
    };
    const model = new VisibleTreeModel<PathEntry>(modelOptions);
    model.update(source, false);
    expectModelMatches(model, source, false);

    const expanded: PathEntry = {
      ...source,
      children: [
        { path: "/repo/src", name: "src", kind: "directory", expanded: true, children: [
          { path: "/repo/src/main.ts", name: "main.ts", kind: "file" },
          { path: "/repo/src/.secret", name: ".secret", kind: "file" },
        ] },
        source.children![1] as PathEntry,
        { path: "/repo/.hidden", name: ".hidden", kind: "file" },
      ],
    };
    model.update(expanded, false);
    expectModelMatches(model, expanded, false);

    const hidden: PathEntry = {
      ...expanded,
      children: [
        { ...(expanded.children![0] as PathEntry), expanded: false, children: undefined },
        expanded.children![1] as PathEntry,
      ],
    };
    model.update(hidden, true);
    expectModelMatches(model, hidden, true);

    const deleted: PathEntry = { ...hidden, children: [hidden.children![1] as PathEntry] };
    model.update(deleted, true);
    expectModelMatches(model, deleted, true);
    expect(model.stats.fullBuilds).toBe(2); // Initial build and hide-dot-files policy change.
  });

  it("keeps row indices current through reorder, move, rename, and delete", () => {
    const alpha: PathEntry = {
      path: "/repo/alpha", name: "alpha", kind: "directory", expanded: true,
      children: [{ path: "/repo/alpha/one.ts", name: "one.ts", kind: "file" }],
    };
    const beta: PathEntry = {
      path: "/repo/beta", name: "beta", kind: "directory", expanded: true,
      children: [
        { path: "/repo/beta/two.ts", name: "two.ts", kind: "file" },
        { path: "/repo/beta/three.ts", name: "three.ts", kind: "file" },
      ],
    };
    const initial: PathEntry = {
      path: "/repo", name: "repo", kind: "directory", expanded: true,
      children: [alpha, beta],
    };
    const model = new VisibleTreeModel<PathEntry>(modelOptions);
    model.update(initial, false);

    const reordered: PathEntry = { ...initial, children: [beta, alpha] };
    model.update(reordered, false);
    expectModelMatches(model, reordered, false);
    const focusKey = model.keyOfPath("/repo/beta/three.ts");
    expect(model.indexOfKey(focusKey)).toBe(3);

    const movedFile: PathEntry = { path: "/repo/beta/one.ts", name: "one.ts", kind: "file" };
    const moved: PathEntry = {
      ...reordered,
      children: [
        { ...beta, children: [...beta.children!, movedFile] },
        { ...alpha, children: [] },
      ],
    };
    model.update(moved, false);
    expectModelMatches(model, moved, false);
    expect(model.indexOfPath("/repo/alpha/one.ts")).toBe(-1);
    expect(model.indexOfPath("/repo/beta/one.ts")).toBe(4);

    const renamedBeta: PathEntry = {
      path: "/repo/renamed", name: "renamed", kind: "directory", expanded: true,
      children: moved.children![0]!.children!.map((entry) => ({
        ...entry,
        path: entry.path.replace("/repo/beta", "/repo/renamed"),
      })) as PathEntry[],
    };
    const renamed: PathEntry = { ...moved, children: [renamedBeta, moved.children![1] as PathEntry] };
    model.update(renamed, false);
    expectModelMatches(model, renamed, false);
    expect(model.indexOfPath("/repo/beta/two.ts")).toBe(-1);
    expect(model.indexOfPath("/repo/renamed/two.ts")).toBe(2);

    const deleted: PathEntry = {
      ...renamed,
      children: [{ ...renamedBeta, children: renamedBeta.children!.slice(0, 1) }, renamed.children![1] as PathEntry],
    };
    model.update(deleted, false);
    expectModelMatches(model, deleted, false);
    expect(model.indexOfPath("/repo/renamed/three.ts")).toBe(-1);
  });

  it("indexes platform comparison keys using the configured path policy", () => {
    const root: PathEntry = {
      path: "C:\\Repo", name: "Repo", kind: "directory", expanded: true,
      children: [{ path: "C:\\Repo\\File.ts", name: "File.ts", kind: "file" }],
    };
    const model = new VisibleTreeModel<PathEntry>({ platform: "windows", casePolicy: "insensitive" });
    model.update(root, false);
    expect(model.indexOfPath("c:/repo/file.ts")).toBe(1);
    expect(model.indexOfPath("C:repo/file.ts")).toBe(-1); // Drive-relative stays distinct.
  });

  it("updates only the changed row records and keeps index lookups constant time", () => {
    const initial = makeIndexedFlatTree(100_000);
    const model = new VisibleTreeModel<PathEntry>(modelOptions);
    model.update(initial, false);
    const initialRowsUpdated = model.stats.rowsUpdated;
    const initialFlattened = model.stats.visibleEntriesFlattened;
    const initialKeyComputations = model.stats.pathKeysComputed;
    const initialChildComparisons = model.stats.directChildEntriesCompared;

    const changedIndex = 50_000;
    const nextChildren = [...initial.children!] as PathEntry[];
    nextChildren[changedIndex] = { ...(nextChildren[changedIndex] as PathEntry), size: 42 };
    const next: PathEntry = { ...initial, children: nextChildren };
    model.update(next, false);

    expect(comparable(model.rows)).toEqual(comparable(flattenVisibleTree(next, false)));
    expect(model.stats.fullBuilds).toBe(1);
    expect(model.stats.visibleEntriesFlattened - initialFlattened).toBe(0);
    expect(model.stats.rowsUpdated - initialRowsUpdated).toBe(2); // The root entry and changed file.
    expect(model.stats.pathKeysComputed - initialKeyComputations).toBe(2); // New root and new file only.
    expect(model.stats.directChildEntriesCompared - initialChildComparisons).toBe(100_000); // A replaced wide child array must be diffed.
    const lookupCount = model.stats.indexLookups;
    const pathKeyCount = model.stats.pathKeysComputed;
    let focusedKey = model.rows[50_000].pathKey;
    for (let update = 0; update < 1_000; update += 1) {
      const index = model.indexOfKey(focusedKey);
      const action = treeKeyboardAction(model.rows, index, update % 2 === 0 ? "ArrowDown" : "ArrowUp");
      expect(action?.kind).toBe("focus");
      if (action?.kind === "focus") focusedKey = model.rows[action.index].pathKey;
      virtualTreeWindow(model.rows.length, update * 27, 540, 27, 8);
    }
    expect(model.stats.indexLookups - lookupCount).toBe(1_000);
    expect(model.stats.pathKeysComputed).toBe(pathKeyCount);
    expect(model.indexOfKey(focusedKey)).toBe(50_000);
  });

  it("updates one branch of a 100k-row tree without flattening stable branches", () => {
    const branchCount = 1_000;
    const filesPerBranch = 100;
    const initial: PathEntry = {
      path: "/repo", name: "repo", kind: "directory", expanded: true,
      children: Array.from({ length: branchCount }, (_, branchIndex) => ({
        path: `/repo/branch-${branchIndex}`,
        name: `branch-${branchIndex}`,
        kind: "directory" as const,
        expanded: true,
        children: Array.from({ length: filesPerBranch }, (_, fileIndex) => ({
          path: `/repo/branch-${branchIndex}/file-${fileIndex}.ts`,
          name: `file-${fileIndex}.ts`,
          kind: "file" as const,
        })),
      })),
    };
    const model = new VisibleTreeModel<PathEntry>(modelOptions);
    model.update(initial, false);
    const flattenedBefore = model.stats.visibleEntriesFlattened;
    const rowsUpdatedBefore = model.stats.rowsUpdated;
    const changedBranchIndex = 500;
    const nextBranches = [...initial.children!] as PathEntry[];
    const previousBranch = nextBranches[changedBranchIndex] as PathEntry;
    const nextFiles = [...previousBranch.children!] as PathEntry[];
    nextFiles[50] = { ...(nextFiles[50] as PathEntry), size: 42 };
    nextBranches[changedBranchIndex] = { ...previousBranch, children: nextFiles };
    const next: PathEntry = { ...initial, children: nextBranches };
    model.update(next, false);

    expect(model.rows).toHaveLength(101_001);
    expect(model.stats.fullBuilds).toBe(1);
    expect(model.stats.visibleEntriesFlattened - flattenedBefore).toBe(0);
    expect(model.stats.directChildEntriesCompared).toBe(1_100); // 1,000 root children plus the edited branch's 100 children.
    expect(model.stats.rowsUpdated - rowsUpdatedBefore).toBe(3); // Root, changed branch, and changed file.
    expect(model.stats.pathKeysComputed).toBe(101_004); // Initial 101,001 rows plus the 3 new entry objects.
    expect(model.indexOfPath("/repo/branch-500/file-50.ts")).toBe(50_552);
    expect(model.indexOfPath("/repo/branch-999/file-99.ts")).toBe(101_000);
  });

  it("splices one changed subtree and counts the unavoidable flat-array suffix shift", () => {
    const stableBranch: PathEntry = {
      path: "/repo/stable", name: "stable", kind: "directory", expanded: true,
      children: Array.from({ length: 500 }, (_, index) => ({
        path: `/repo/stable/${index}.ts`, name: `${index}.ts`, kind: "file" as const,
      })),
    };
    const editedBranch: PathEntry = {
      path: "/repo/edited", name: "edited", kind: "directory", expanded: true,
      children: Array.from({ length: 1_000 }, (_, index) => ({
        path: `/repo/edited/${index}.ts`, name: `${index}.ts`, kind: "file" as const,
      })),
    };
    const initial: PathEntry = {
      path: "/repo", name: "repo", kind: "directory", expanded: true,
      children: [editedBranch, stableBranch],
    };
    const model = new VisibleTreeModel<PathEntry>(modelOptions);
    model.update(initial, false);
    const flattenedBefore = model.stats.visibleEntriesFlattened;
    const shiftedBefore = model.stats.rowsShifted;
    const changed: PathEntry = {
      ...initial,
      children: [
        { ...editedBranch, children: [...editedBranch.children!, { path: "/repo/edited/new.ts", name: "new.ts", kind: "file" }] },
        stableBranch,
      ],
    };
    model.update(changed, false);

    expect(comparable(model.rows)).toEqual(comparable(flattenVisibleTree(changed, false)));
    expect(model.stats.fullBuilds).toBe(1);
    expect(model.stats.visibleEntriesFlattened - flattenedBefore).toBe(1);
    expect(model.stats.rowsShifted - shiftedBefore).toBe(501); // Stable folder plus its 500 rows move by one.
    expect(model.indexOfPath("/repo/stable/499.ts")).toBe(1_503);
  });
});

describe("tree keyboard navigation", () => {
  const rows = flattenVisibleTree({
    name: "workspace", kind: "directory", expanded: true,
    children: [
      { name: "src", kind: "directory", expanded: true, children: [{ name: "main.ts", kind: "file" }] },
      { name: "empty", kind: "directory", expanded: true },
      { name: "closed", kind: "directory", expanded: false },
      { name: "link", kind: "symlink" },
    ],
  }, false);

  it("moves into a folder and back to the nearest parent without crossing siblings", () => {
    expect(treeKeyboardAction(rows, 1, "ArrowRight")).toEqual({ kind: "focus", index: 2 });
    expect(treeKeyboardAction(rows, 2, "ArrowLeft")).toEqual({ kind: "focus", index: 1 });
    expect(treeKeyboardAction(rows, 3, "ArrowRight")).toBeUndefined();
    expect(treeKeyboardAction(rows, 4, "ArrowLeft")).toEqual({ kind: "focus", index: 0 });
  });

  it("expands and collapses folders, and opens files or symlinks", () => {
    expect(treeKeyboardAction(rows, 4, "ArrowRight")).toEqual({ kind: "toggle" });
    expect(treeKeyboardAction(rows, 1, "ArrowLeft")).toEqual({ kind: "toggle" });
    expect(treeKeyboardAction(rows, 1, "Enter")).toEqual({ kind: "toggle" });
    expect(treeKeyboardAction(rows, 2, "Enter")).toEqual({ kind: "open" });
    expect(treeKeyboardAction(rows, 5, " ")).toEqual({ kind: "open" });
  });

  it("keeps focus at the ends and ignores absent rows or unrelated keys", () => {
    expect(treeKeyboardAction(rows, 0, "ArrowUp")).toEqual({ kind: "focus", index: 0 });
    expect(treeKeyboardAction(rows, 5, "ArrowDown")).toEqual({ kind: "focus", index: 5 });
    expect(treeKeyboardAction(rows, 0, "ArrowLeft")).toEqual({ kind: "toggle" });
    expect(treeKeyboardAction(flattenVisibleTree({ name: "root", kind: "directory", expanded: false }, false), 0, "ArrowLeft")).toBeUndefined();
    expect(treeKeyboardAction([], 0, "End")).toBeUndefined();
    expect(treeKeyboardAction(rows, -1, "Enter")).toBeUndefined();
    expect(treeKeyboardAction(rows, 2, "Tab")).toBeUndefined();
  });

  it("reaches rows outside the rendered window in a 100,000 file directory", () => {
    const large = flattenVisibleTree(makeFlatTree(100_000), false);
    expect(treeKeyboardAction(large, 0, "End")).toEqual({ kind: "focus", index: 100_000 });
    expect(treeKeyboardAction(large, 100_000, "Home")).toEqual({ kind: "focus", index: 0 });
    expect(treeKeyboardAction(large, 100_000, "ArrowLeft")).toEqual({ kind: "focus", index: 0 });
    const viewport = virtualTreeWindow(large.length, 100_000 * 27, 540, 27, 8);
    expect(viewport.end - viewport.start).toBeLessThanOrEqual(29);
  });
});
