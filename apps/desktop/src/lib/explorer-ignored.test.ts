import { describe, expect, it } from "vitest";
import type { DirectoryEntry } from "../types";
import { groupIgnoredEntries, loadedExplorerPaths, type ExplorerEntry } from "./explorer-ignored";
import { treeKeyboardAction, VisibleTreeModel } from "./tree-virtualization";

const root: DirectoryEntry = {
  path: "/repo", name: "repo", kind: "directory", expanded: true,
  children: [
    { path: "/repo/src", name: "src", kind: "directory", expanded: true, children: [
      { path: "/repo/src/cache.log", name: "cache.log", kind: "file" },
    ] },
    { path: "/repo/node_modules", name: "node_modules", kind: "directory", expanded: true, children: [
      { path: "/repo/node_modules/module.js", name: "module.js", kind: "file" },
    ] },
    { path: "/repo/.env", name: ".env", kind: "file" },
    { path: "/repo/README.md", name: "README.md", kind: "file" },
  ],
};
const ignored = new Set(["/repo/node_modules", "/repo/.env", "/repo/src/cache.log"]);
const isIgnored = (path: string) => ignored.has(path);

describe("Explorer ignored entries", () => {
  it("groups only root children and preserves the original entries and tree", () => {
    const projected = groupIgnoredEntries(root, isIgnored, false, false);
    expect(projected.children?.map((entry) => entry.name)).toEqual(["src", "README.md", "Git ignored"]);
    const group = projected.children?.at(-1) as ExplorerEntry;
    expect(group).toMatchObject({ gitIgnoredGroup: true, expanded: false });
    expect(group.children).toEqual([root.children![1], root.children![2]]);
    expect(projected.children![0]).toBe(root.children![0]);
    expect(root.children).toHaveLength(4);
    expect(root.children![0].children![0].name).toBe("cache.log");
  });

  it("supports keyboard expansion, parent navigation and collapse with the virtual tree", () => {
    const model = new VisibleTreeModel<ExplorerEntry>();
    model.update(groupIgnoredEntries(root, isIgnored, false, false), false);
    const groupIndex = model.rows.findIndex((row) => row.entry.gitIgnoredGroup);
    expect(treeKeyboardAction(model.rows, groupIndex, "ArrowRight")).toEqual({ kind: "toggle" });
    model.update(groupIgnoredEntries(root, isIgnored, true, false), false);
    expect(model.rows.map((row) => row.entry.name)).toEqual(["repo", "src", "cache.log", "README.md", "Git ignored", "node_modules", "module.js", ".env"]);
    expect(treeKeyboardAction(model.rows, groupIndex + 1, "ArrowLeft")).toEqual({ kind: "toggle" });
    expect(treeKeyboardAction(model.rows, model.rows.length - 1, "ArrowLeft")).toEqual({ kind: "focus", index: groupIndex });
    model.update(groupIgnoredEntries(root, isIgnored, false, false), false);
    expect(model.indexOfPath("/repo/node_modules/module.js")).toBe(-1);
  });

  it("does not show an empty group when dotfiles are hidden or nothing is ignored", () => {
    expect(groupIgnoredEntries(root, () => false, false, false)).toBe(root);
    expect(groupIgnoredEntries(root, (path) => path === "/repo/.env", false, true)).toBe(root);
    const projected = groupIgnoredEntries(root, isIgnored, true, true);
    const model = new VisibleTreeModel<ExplorerEntry>();
    model.update(projected, true);
    expect(model.indexOfPath("/repo/.env")).toBe(-1);
    expect(model.indexOfPath("/repo/node_modules")).toBeGreaterThan(0);
  });

  it("collects loaded descendants even inside collapsed directories", () => {
    expect(new Set(loadedExplorerPaths(root))).toEqual(new Set([
      "/repo/src", "/repo/src/cache.log", "/repo/node_modules", "/repo/node_modules/module.js", "/repo/.env", "/repo/README.md",
    ]));
    expect(loadedExplorerPaths({ ...root, children: undefined })).toEqual([]);
  });
});
