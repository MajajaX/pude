import { describe, expect, it } from "vitest";
import type { DirectoryEntry } from "../types";
import { collapseSubfolders, folderContaining, isWorkspaceRootEntry, makeWorkspaceRoot, watcherExcludesForFolders, workspaceLabel, workspaceRootFolders, WORKSPACE_ROOT_PATH } from "./workspace-folders";

const posix = { platform: "posix" as const };

describe("workspace folders", () => {
  it("labels saved, unsaved and single-folder projects", () => {
    expect(workspaceLabel(["/work/web"], "/work/team.pdw", posix)).toBe("team");
    expect(workspaceLabel(["/work/web", "/work/api", "/work/docs"], undefined, posix)).toBe("web +2");
    expect(workspaceLabel(["/work/web"], undefined, posix)).toBe("web");
    expect(workspaceLabel([], undefined, posix)).toBe("");
  });

  it("uses a folder as its own root and groups several folders under a workspace row", () => {
    const single = makeWorkspaceRoot(["/work/web"], "web", undefined, posix);
    expect(single).toMatchObject({ path: "/work/web", name: "web", expanded: true, loaded: false });
    const loadedWeb: DirectoryEntry = { ...single, loaded: true, children: [{ name: "index.ts", path: "/work/web/index.ts", kind: "file" }] };
    const multi = makeWorkspaceRoot(["/work/web", "/work/api"], "team", loadedWeb, posix);
    expect(isWorkspaceRootEntry(multi)).toBe(true);
    expect(multi.name).toBe("team (Workspace)");
    expect(workspaceRootFolders(multi)[0]).toBe(loadedWeb);
    expect(workspaceRootFolders(multi)[1]).toMatchObject({ path: "/work/api", loaded: false });
    const collapsed = { ...multi, expanded: false };
    expect(makeWorkspaceRoot(["/work/web", "/work/api", "/work/docs"], "team", collapsed, posix).expanded).toBe(false);
    expect(makeWorkspaceRoot(["/work/web"], "web", multi, posix)).toBe(loadedWeb);
    expect(workspaceRootFolders(single)).toEqual([single]);
    expect(WORKSPACE_ROOT_PATH.startsWith("pude://")).toBe(true);
  });

  it("finds the deepest folder that contains a path", () => {
    const folders = ["/work", "/work/web", "/other"];
    expect(folderContaining("/work/web/src/a.ts", folders, posix)).toBe("/work/web");
    expect(folderContaining("/work/readme.md", folders, posix)).toBe("/work");
    expect(folderContaining("/elsewhere/a.ts", folders, posix)).toBeUndefined();
  });

  it("applies relative watcher excludes to every folder", () => {
    const join = (folder: string, path: string) => `${folder}/${path}`;
    expect(watcherExcludesForFolders(["node_modules", "/tmp/cache"], ["/work/web", "/work/api"], join))
      .toEqual(["node_modules", "/tmp/cache", "/work/api/node_modules"]);
  });
});

describe("collapse subfolders", () => {
  const folder = (path: string, children: DirectoryEntry[] = []): DirectoryEntry => ({ name: path, path, kind: "directory", expanded: true, loaded: true, children });
  it("keeps top-level folders open and closes everything below them", () => {
    const tree = folder("/a", [folder("/a/b", [folder("/a/b/c")]), { name: "f", path: "/a/f", kind: "file" }]);
    const collapsed = collapseSubfolders(tree);
    expect(collapsed.expanded).toBe(true);
    expect(collapsed.children?.[0].expanded).toBe(false);
    expect(collapsed.children?.[0].children?.[0].expanded).toBe(false);
    expect(collapsed.children?.[1]).toBe(tree.children?.[1]);
  });

  it("keeps every folder of a multi-folder workspace open", () => {
    const tree: DirectoryEntry = { name: "w", path: WORKSPACE_ROOT_PATH, kind: "directory", expanded: true, children: [folder("/a", [folder("/a/b")]), folder("/c")] };
    const collapsed = collapseSubfolders(tree);
    expect(collapsed.children?.map((entry) => entry.expanded)).toEqual([true, true]);
    expect(collapsed.children?.[0].children?.[0].expanded).toBe(false);
  });
});
