import { describe, expect, it } from "vitest";
import { createRestoreIntent, markRestoreTabCancelled, markUserOpenedPath, shouldMergeRestoredTab } from "./restore-state";
import { restoreDirectoryTreeByLevel } from "./directory-restore";
import { runtimePathOptions } from "./path-identity";
import type { DirectoryEntry } from "../types";
import type { PersistedTab } from "./session-storage";

const persisted = (id: string, path: string): PersistedTab => ({
  id,
  path,
  name: path.split("/").at(-1) ?? path,
  dirty: true,
  lineEnding: "lf",
  encoding: "UTF-8",
  language: "Plain Text",
  cursorLine: 1,
  cursorColumn: 1,
  revision: 1,
  savedRevision: 0,
  contentVersion: 0,
});

describe("restore intent", () => {
  it("does not resurrect a tab cancelled while its read is pending", () => {
    const original = persisted("tab-1", "/workspace/a.ts");
    const intent = markRestoreTabCancelled(createRestoreIntent([original], 1), original.id);
    expect(shouldMergeRestoredTab(intent, original, new Set())).toBe(false);
  });

  it("does not merge a persisted path replaced by a user opened tab", () => {
    const original = persisted("tab-1", "/workspace/a.ts");
    const intent = markUserOpenedPath(createRestoreIntent([original], 1), "/workspace/a.ts");
    expect(shouldMergeRestoredTab(intent, original, new Set())).toBe(false);
  });

  it("uses the shared platform path policy when matching opened restore paths", () => {
    const original = persisted("tab-1", "/workspace/folder/file.ts");
    const intent = markUserOpenedPath(createRestoreIntent([original], 1), "/workspace/folder\\file.ts");
    const windows = runtimePathOptions().platform === "windows";

    expect(shouldMergeRestoredTab(intent, original, new Set())).toBe(!windows);
  });
});

describe("incremental directory restore", () => {
  it("emits the root before loading deeper expanded directories", async () => {
    const root: DirectoryEntry = { name: "workspace", path: "/workspace", kind: "directory", expanded: true, loaded: true, children: [{ name: "src", path: "/workspace/src", kind: "directory", expanded: true, loaded: false }] };
    const emitted: number[] = [];
    const result = await restoreDirectoryTreeByLevel({
      root,
      expandedPaths: new Set(["/workspace", "/workspace/src"]),
      listDirectory: async (path) => ({ entries: path === "/workspace/src" ? [{ name: "main.ts", path: "/workspace/src/main.ts", kind: "file" }] : [] }),
      isCurrent: () => true,
      onTree: (_tree, depth) => emitted.push(depth),
    });
    expect(emitted).toEqual([0, 1]);
    expect(result.tree.children?.[0].children?.[0].path).toBe("/workspace/src/main.ts");
  });

  it("stops before committing a result after the workspace changes", async () => {
    let current = true;
    const emitted: number[] = [];
    const root: DirectoryEntry = { name: "workspace", path: "/workspace", kind: "directory", expanded: true, loaded: true, children: [{ name: "src", path: "/workspace/src", kind: "directory", expanded: true, loaded: false }] };
    const result = await restoreDirectoryTreeByLevel({
      root,
      expandedPaths: new Set(["/workspace", "/workspace/src"]),
      listDirectory: async () => { current = false; return { entries: [] }; },
      isCurrent: () => current,
      onTree: (_tree, depth) => emitted.push(depth),
    });
    expect(emitted).toEqual([0]);
    expect(result.interrupted).toBe(true);
  });

  it("keeps native partial directory errors on the affected entry", async () => {
    const root: DirectoryEntry = { name: "workspace", path: "/workspace", kind: "directory", expanded: true, loaded: true, children: [{ name: "src", path: "/workspace/src", kind: "directory", expanded: true, loaded: false }] };
    const result = await restoreDirectoryTreeByLevel({
      root,
      expandedPaths: new Set(["/workspace", "/workspace/src"]),
      listDirectory: async () => ({ entries: [], partialError: { kind: "entry", message: "permission denied" } }),
      isCurrent: () => true,
      onTree: () => undefined,
    });
    expect(result.tree.children?.[0].partialError).toEqual({ kind: "entry", message: "permission denied" });
  });

  it("keeps incomplete listing and cap metadata on the restored directory", async () => {
    const root: DirectoryEntry = { name: "workspace", path: "/workspace", kind: "directory", expanded: true, loaded: true, children: [{ name: "src", path: "/workspace/src", kind: "directory", expanded: true, loaded: false }] };
    const result = await restoreDirectoryTreeByLevel({
      root,
      expandedPaths: new Set(["/workspace", "/workspace/src"]),
      listDirectory: async () => ({ entries: [], incomplete: true, stopReason: "entryLimit", maxEntries: 1, scannedEntries: 2 }),
      isCurrent: () => true,
      onTree: () => undefined,
    });
    const restored = result.tree.children?.[0];
    expect(restored?.incomplete).toBe(true);
    expect(restored?.listingStopReason).toBe("entryLimit");
  });
});
