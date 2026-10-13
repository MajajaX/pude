import { describe, expect, it, vi } from "vitest";
import type { DirectoryEntry } from "../types";
import { createExpandedPathsCache } from "./expanded-paths";
import { collectExpandedPaths } from "./session-storage";

const makeTree = (): DirectoryEntry => ({
  name: "workspace",
  path: "/workspace",
  kind: "directory",
  expanded: true,
  loaded: true,
  children: [
    { name: "src", path: "/workspace/src", kind: "directory", expanded: true, loaded: true },
    { name: "closed", path: "/workspace/closed", kind: "directory", expanded: false, loaded: false },
  ],
});

describe("createExpandedPathsCache", () => {
  it("reuses the collected paths while the tree identity is unchanged", () => {
    const collect = vi.fn(collectExpandedPaths);
    const cache = createExpandedPathsCache(collect);
    const tree = makeTree();
    const first = cache.current(tree);
    expect(first).toEqual(["/workspace", "/workspace/src"]);
    expect(cache.current(tree)).toBe(first);
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it("re-collects when the tree is rebuilt (expand, collapse or relist)", () => {
    const cache = createExpandedPathsCache(collectExpandedPaths);
    const tree = makeTree();
    cache.current(tree);
    // Every immutable tree update produces a new root object; simulate a
    // collapse of /workspace/src the way toggleDirectory does.
    const collapsedSrc: DirectoryEntry = {
      ...tree,
      children: [
        { ...tree.children![0], expanded: false },
        tree.children![1],
      ],
    };
    expect(cache.current(collapsedSrc)).toEqual(["/workspace"]);
    // A fresh root (workspace switch) is also a new identity.
    const rebuilt = makeTree();
    expect(cache.current(rebuilt)).toEqual(["/workspace", "/workspace/src"]);
  });

  it("keeps each project's tree cached while switching between projects", () => {
    const collect = vi.fn(collectExpandedPaths);
    const cache = createExpandedPathsCache(collect);
    const first = makeTree();
    const second = makeTree();
    cache.current(first);
    cache.current(second);
    cache.current(first);
    cache.current(second);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("invalidate forces the next read to re-collect", () => {
    const collect = vi.fn(collectExpandedPaths);
    const cache = createExpandedPathsCache(collect);
    const tree = makeTree();
    cache.current(tree);
    cache.invalidate();
    cache.current(tree);
    expect(collect).toHaveBeenCalledTimes(2);
  });
});
