import { describe, expect, it } from "vitest";
import { createExternalConflictController, type ExternalConflictHooks } from "./external-conflict-controller";
import type { EditorTab, ReadFileResult } from "../types";

const tab = (overrides: Partial<EditorTab> = {}): EditorTab => ({
  id: "tab-1",
  path: "/workspace/file.ts",
  name: "file.ts",
  content: "editor",
  savedContent: "saved",
  dirty: true,
  lineEnding: "lf",
  encoding: "UTF-8",
  language: "TypeScript",
  cursorLine: 1,
  cursorColumn: 1,
  revision: 3,
  savedRevision: 2,
  contentVersion: 7,
  ...overrides,
});

const file = (overrides: Partial<ReadFileResult> = {}): ReadFileResult => ({
  path: "/workspace/file.ts",
  content: "disk",
  encoding: "utf-8",
  lineEnding: "lf",
  modifiedAt: 20,
  size: 4,
  fingerprint: "fp-1",
  lineEndings: "",
  bom: false,
  identity: null,
  ...overrides,
});

type ControllerSetup = {
  controller: ReturnType<typeof createExternalConflictController>;
  queuedList: () => EditorTab[];
  hooks: {
    readFile: (path: string) => Promise<ReadFileResult>;
    tabs: Map<string, EditorTab>;
    updates: { id: string; changes: Partial<EditorTab> }[];
    bumps: string[];
    diffs: { path: string; diffText: string }[];
    notifications: string[];
    generation: number;
  };
};

const createController = (options: { readFile?: (path: string) => Promise<ReadFileResult>; liveTabs?: EditorTab[]; generation?: number } = {}): ControllerSetup => {
  let items: EditorTab[] = [];
  const tabs = new Map<string, EditorTab>(options.liveTabs?.map((item) => [item.id, item]));
  const updates: { id: string; changes: Partial<EditorTab> }[] = [];
  const bumps: string[] = [];
  const diffs: { path: string; diffText: string }[] = [];
  const notifications: string[] = [];
  const setup: ControllerSetup["hooks"] = {
    readFile: options.readFile ?? (() => Promise.resolve(file())),
    tabs,
    updates,
    bumps,
    diffs,
    notifications,
    generation: options.generation ?? 0,
  };
  const hooks: ExternalConflictHooks = {
    readFile: (path) => setup.readFile(path),
    normalizeReadFile: (result) => result,
    getWorkspaceGeneration: () => setup.generation,
    getTab: (id) => setup.tabs.get(id),
    samePath: (left, right) => left === right,
    updateTab: (id, changes) => updates.push({ id, changes }),
    bumpDocumentContentRevision: (tabId) => bumps.push(tabId),
    getDocumentText: (item) => item.content,
    buildTextDiff: (before, after) => `diff(${before},${after})`,
    openDiskDiff: (path, diffText) => diffs.push({ path, diffText }),
    notify: (message) => notifications.push(message),
    errorMessage: (error, fallback) => (error instanceof Error ? error.message : fallback),
  };
  const controller = createExternalConflictController(
    {
      queued: () => items,
      setQueued: (updater) => {
        items = updater(items);
      },
    },
    hooks,
  );
  return { controller, queuedList: () => items, hooks: setup };
};

describe("external conflict controller queue", () => {
  it("appends new conflicts and upserts existing ones in place", () => {
    const { controller, queuedList } = createController();
    const first = tab({ id: "tab-1" });
    const second = tab({ id: "tab-2", path: "/workspace/other.ts" });
    controller.queue(first);
    controller.queue(second);
    expect(queuedList()).toEqual([first, second]);
    const refreshed = tab({ id: "tab-1", revision: 9 });
    controller.queue(refreshed);
    expect(queuedList()).toEqual([refreshed, second]);
  });

  it("dismisses by tab id and resets the whole queue", () => {
    const { controller, queuedList } = createController();
    controller.queue(tab({ id: "tab-1" }));
    controller.queue(tab({ id: "tab-2", path: "/workspace/other.ts" }));
    controller.dismiss("tab-1");
    expect(queuedList().map((item) => item.id)).toEqual(["tab-2"]);
    controller.reset();
    expect(queuedList()).toEqual([]);
  });

  it("resolves the first queued conflict against the live tab when present", () => {
    const stale = tab({ id: "tab-1" });
    const live = tab({ id: "tab-1", revision: 8 });
    const { controller } = createController({ liveTabs: [live] });
    controller.queue(stale);
    expect(controller.first()).toBe(live);
    controller.dismiss("tab-1");
    expect(controller.first()).toBeUndefined();
  });

  it("clears the queue on dispose", () => {
    const { controller, queuedList } = createController();
    controller.queue(tab());
    controller.dispose();
    expect(queuedList()).toEqual([]);
  });
});

describe("external conflict controller reload", () => {
  it("applies the on-disk version, bumps the revision, dismisses and notifies", async () => {
    const { controller, hooks } = createController({ liveTabs: [tab()] });
    controller.queue(tab());
    await controller.reload();
    expect(hooks.updates).toHaveLength(1);
    expect(hooks.updates[0].id).toBe("tab-1");
    expect(hooks.updates[0].changes).toMatchObject({
      content: "disk",
      savedContent: "disk",
      dirty: false,
      orphaned: false,
      revision: 4,
      savedRevision: 4,
      contentVersion: 8,
      diskModifiedAt: 20,
      diskSize: 4,
      diskFingerprint: "fp-1",
      encoding: "UTF-8",
      largeFile: false,
    });
    expect(hooks.bumps).toEqual(["tab-1"]);
    expect(hooks.notifications).toEqual(["Reloaded file.ts"]);
  });

  it("does nothing when no conflict is queued", async () => {
    const { controller, hooks } = createController();
    await controller.reload();
    expect(hooks.updates).toEqual([]);
    expect(hooks.notifications).toEqual([]);
  });

  it("aborts when the workspace generation changed while reading", async () => {
    const setup = createController({ liveTabs: [tab()] });
    setup.hooks.readFile = () => new Promise((resolve) => setTimeout(() => resolve(file()), 0));
    setup.controller.queue(tab());
    const pending = setup.controller.reload();
    setup.hooks.generation = 1;
    await pending;
    expect(setup.hooks.updates).toEqual([]);
    expect(setup.hooks.notifications).toEqual([]);
  });

  it("aborts when the tab revision moved while reading", async () => {
    const moved = createController({ liveTabs: [tab()] });
    moved.controller.queue(tab());
    const pending = moved.controller.reload();
    moved.hooks.tabs.set("tab-1", tab({ revision: 4 }));
    await pending;
    expect(moved.hooks.updates).toEqual([]);
    expect(moved.hooks.notifications).toEqual([]);

    const missing = createController({ liveTabs: [] });
    missing.controller.queue(tab());
    await missing.controller.reload();
    expect(missing.hooks.updates).toEqual([]);
  });

  it("notifies the fallback message when the read fails", async () => {
    const { controller, hooks } = createController({
      liveTabs: [tab()],
      readFile: () => Promise.reject(new Error("denied")),
    });
    controller.queue(tab());
    await controller.reload();
    expect(hooks.updates).toEqual([]);
    expect(hooks.notifications).toEqual(["denied"]);
  });
});

describe("external conflict controller compare", () => {
  it("opens an editor-vs-disk diff and dismisses the resolved prompt", async () => {
    const { controller, hooks } = createController({ liveTabs: [tab({ content: "editor text" })] });
    controller.queue(tab());
    await controller.compare(tab());
    expect(hooks.diffs).toEqual([{ path: "/workspace/file.ts", diffText: "diff(editor text,disk)" }]);
    expect(controller.first()).toBeUndefined();
  });

  it("aborts when the tab revision moved while reading", async () => {
    const setup = createController({ liveTabs: [tab()] });
    setup.hooks.readFile = () => new Promise((resolve) => setTimeout(() => resolve(file()), 0));
    setup.controller.queue(tab());
    const pending = setup.controller.compare(tab());
    setup.hooks.tabs.set("tab-1", tab({ revision: 4 }));
    await pending;
    expect(setup.hooks.diffs).toEqual([]);
    expect(setup.controller.first()?.revision).toBe(4);
  });

  it("notifies the fallback message when the read fails", async () => {
    const { controller, hooks } = createController({
      liveTabs: [tab()],
      readFile: () => Promise.reject(new Error("gone")),
    });
    controller.queue(tab());
    await controller.compare(tab());
    expect(hooks.diffs).toEqual([]);
    expect(hooks.notifications).toEqual(["gone"]);
    expect(controller.first()).toBeDefined();
  });
});
