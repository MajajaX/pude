import { describe, expect, it } from "vitest";
import { createProject, projectCacheBytes, projectHasDirtyTabs, projectSession, restoreProjectDocuments } from "./project-workspace";
import { createRestoreIntent, markRestoreTabStarted, markUserOpenedPath } from "./restore-state";
import { createSessionMetadata } from "./session-storage-schema";
import type { EditorTab, ReadFileResult } from "../types";

const root = { name: "workspace", path: "/workspace", kind: "directory" as const, expanded: true };
const tab: EditorTab = {
  id: "document", path: "/workspace/note.txt", name: "note.txt", content: "original", savedContent: "original",
  dirty: false, lineEnding: "lf", encoding: "UTF-8", language: "Plain Text", cursorLine: 3, cursorColumn: 2,
  revision: 0, savedRevision: 0, contentVersion: 0,
};
const session = createSessionMetadata(root.path, tab.id, [tab], root);
const file: ReadFileResult = { path: tab.path, content: "original", lineEnding: "lf", lineEndings: "", encoding: "utf-8", size: 8, modifiedAt: 1, identity: "disk", bom: false, fingerprint: "disk" };

function harness() {
  let intent = createRestoreIntent(session.tabs, 1);
  let tabs: EditorTab[] = [];
  let current = true;
  const failures: string[] = [];
  const options = {
    session, intent, scope: "window", recoveries: {}, isCurrent: () => current,
    readDocument: async () => file, normalizeReadFile: (value: ReadFileResult) => value,
    createImageTab: () => tab, getTabs: () => tabs, getIntent: () => intent,
    onTabs: (value: EditorTab[]) => { tabs = value; }, onIntent: (value: typeof intent) => { intent = value; },
    onConflict: () => {}, onFailure: (failure: { path: string }) => { failures.push(failure.path); },
  };
  return { options, getTabs: () => tabs, getIntent: () => intent, failures,
    supersede: () => { current = false; }, open: (value: EditorTab) => { tabs = [value]; intent = markUserOpenedPath(intent, value.path); } };
}

describe("parked project documents", () => {
  it("counts parked closed documents in the shared cache budget without double counting open documents", () => {
    const first = { ...createProject("first", root.path, root), lastClosedTab: tab };
    const second = { ...createProject("second", "/other", root), lastClosedTab: { ...tab, id: "closed" } };
    expect(projectCacheBytes([tab], [first, second])).toBe(4 * tab.content.length);
  });

  it("retains unresolved dirty metadata while a different project is active", () => {
    const project = createProject("parked", root.path, root);
    project.restoreMetadata = createSessionMetadata(root.path, tab.id, [{ ...tab, dirty: true }], root);
    project.restoreIntent = createRestoreIntent(project.restoreMetadata.tabs, 1);
    expect(projectSession(project, () => undefined, (path) => path).tabs[0]).toMatchObject({ id: tab.id, dirty: true, cursorLine: 3 });
  });

  it("reports parked unsaved changes until the restored document is loaded or the path is reopened", () => {
    const project = createProject("parked", root.path, root);
    project.restoreMetadata = createSessionMetadata(root.path, tab.id, [{ ...tab, dirty: true }], root);
    project.restoreIntent = createRestoreIntent(project.restoreMetadata.tabs, 1);
    expect(projectHasDirtyTabs(project, () => undefined, (path) => path)).toBe(true);
    expect(projectHasDirtyTabs({ ...project, tabIds: [tab.id] }, () => tab, (path) => path)).toBe(false);
    expect(projectHasDirtyTabs({ ...project, restoreIntent: markUserOpenedPath(project.restoreIntent, tab.path) }, () => undefined, (path) => path)).toBe(false);
  });

  it("keeps pending file tabs in their original positions when only the active document has loaded", () => {
    const before = { ...tab, id: "before", path: "/workspace/before.txt" };
    const after = { ...tab, id: "after", path: "/workspace/after.txt" };
    const project = createProject("partial", root.path, root);
    project.tabIds = [tab.id];
    project.restoreMetadata = createSessionMetadata(root.path, tab.id, [before, tab, after], root);
    project.restoreIntent = markRestoreTabStarted(createRestoreIntent(project.restoreMetadata.tabs, 1), tab.id);
    expect(projectSession(project, (id) => id === tab.id ? tab : undefined, (path) => path).tabs.map((tab) => tab.id)).toEqual(["before", tab.id, "after"]);
  });

  it("persists a loaded tree's collapsed folders instead of restoring old expansion metadata", () => {
    const project = createProject("collapsed", root.path, { ...root, loaded: true });
    project.restoreMetadata = { ...session, expandedPaths: [root.path, "/workspace/src"] };
    expect(projectSession(project, () => undefined, (path) => path).expandedPaths).toEqual([root.path]);
  });

  it("restores a parked project without losing its active document and cursor", async () => {
    const state = harness();
    expect(await restoreProjectDocuments(state.options)).toBe(true);
    expect(state.getTabs()[0]).toMatchObject({ id: tab.id, content: "original", cursorLine: 3, cursorColumn: 2 });
    expect(state.getIntent().pendingTabIds.size).toBe(0);
  });

  it("fences a delayed read after project selection changes", async () => {
    const state = harness();
    let resolve!: (file: ReadFileResult) => void;
    state.options.readDocument = () => new Promise((done) => { resolve = done; });
    const pending = restoreProjectDocuments(state.options);
    await Promise.resolve();
    await Promise.resolve();
    state.supersede();
    resolve(file);
    expect(await pending).toBe(false);
    expect(state.getTabs()).toEqual([]);
    expect(state.getIntent().pendingTabIds.has(tab.id)).toBe(true);
  });

  it("does not overwrite a user-opened document when restoration completes", async () => {
    const state = harness();
    let resolve!: (file: ReadFileResult) => void;
    state.options.readDocument = () => new Promise((done) => { resolve = done; });
    const pending = restoreProjectDocuments(state.options);
    await Promise.resolve();
    await Promise.resolve();
    state.open({ ...tab, id: "user-document", content: "user edit", dirty: true });
    resolve(file);
    await pending;
    expect(state.getTabs()).toHaveLength(1);
    expect(state.getTabs()[0]).toMatchObject({ id: "user-document", content: "user edit", dirty: true });
  });

  it("retains recovery metadata when a document cannot be read", async () => {
    const state = harness();
    state.options.readDocument = async () => { throw new Error("Permission denied"); };
    expect(await restoreProjectDocuments(state.options)).toBe(false);
    expect(state.getIntent().pendingTabIds.has(tab.id)).toBe(true);
    expect(state.failures).toEqual([tab.path]);
  });
});
