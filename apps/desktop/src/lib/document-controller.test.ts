import { describe, expect, it } from "vitest";
import { createDocumentController } from "./document-controller";
import type { EditorDocumentHandle, EditorDocumentSeed } from "../components/EditorPane";
import type { EditorDocumentEvictionState, EditorDocumentFootprint } from "./editor-cache";
import type { EditorTab } from "../types";
import { createEditorSelectionFallback } from "./editor-selection-fallback";

const createCounter = () => {
  let value = 0;
  return { read: () => value, bump: () => { value += 1; } };
};

const seed = (content: string, lineEndings = ""): EditorDocumentSeed => ({
  content,
  lineEndings,
  savedContent: "disk baseline",
  savedLineEndings: "",
  lineEnding: "lf",
  bom: false,
  savedBom: false,
  encoding: "UTF-8",
  revision: 2,
  savedRevision: 1,
  sourceVersion: 1,
  estimatedBytes: content.length,
  largeFile: false,
});

const handle = (
  text: string,
  lineEndings = "",
  evictionOverrides: Partial<EditorDocumentEvictionState> = {},
  seedOverrides: Partial<EditorDocumentSeed> = {},
): EditorDocumentHandle => {
  const textIdentity = {};
  const detachedSeed = { ...seed(text, lineEndings), ...seedOverrides };
  const evictionState: EditorDocumentEvictionState = {
    lastUsed: 1,
    dirty: true,
    hasUndoHistory: true,
    canRelease: false,
    ...evictionOverrides,
  };
  return {
    getText: () => text,
    getRange: (from, to) => text.slice(from, to),
    getTextLength: () => text.length,
    getMetadata: () => ({ revision: 2, estimatedBytes: text.length, largeFile: false }),
    getCacheFootprint: () => ({
      texts: [{ identity: textIdentity, codeUnits: text.length }],
      lineEndingMaps: [],
      serializedHistoryBytes: 128,
      lineEndingHistoryEntries: 0,
      selectionBytes: 0,
      hasState: false,
    } satisfies EditorDocumentFootprint),
    getCacheEvictionState: () => evictionState,
    getSnapshot: () => ({
      content: text,
      revision: 2,
      lineEndings,
      lineEnding: "crlf",
      bom: false,
      encoding: "UTF-8",
      savedRevision: 1,
      savedLineEndings: "",
      savedBom: false,
      estimatedBytes: text.length + lineEndings.length,
    }),
    getDetachedDocument: () => detachedSeed,
    getSelection: () => undefined,
    getCursor: () => undefined,
    applyEdits: () => false,
  };
};

const tab = (overrides: Partial<EditorTab> = {}): EditorTab => ({
  id: "tab-1",
  path: "/workspace/file.ts",
  name: "file.ts",
  content: "fallback",
  savedContent: "fallback",
  dirty: false,
  lineEnding: "lf",
  encoding: "UTF-8",
  language: "TypeScript",
  cursorLine: 1,
  cursorColumn: 1,
  revision: 1,
  savedRevision: 1,
  contentVersion: 1,
  ...overrides,
});

describe("document controller registry", () => {
  it("returns live text from the handle and falls back to the tab content", () => {
    const controller = createDocumentController({ createRevision: createCounter });
    controller.register("tab-1", handle("live"));
    expect(controller.getText(tab())).toBe("live");
    expect(controller.getText(tab({ id: "tab-2" }))).toBe("fallback");
    expect(controller.getText()).toBe("");
  });

  it("creates one revision per tab lazily and reuses it", () => {
    let created = 0;
    const controller = createDocumentController({ createRevision: () => { created += 1; return createCounter(); } });
    const first = controller.getRevision("tab-1");
    const second = controller.getRevision("tab-1");
    expect(second).toBe(first);
    expect(created).toBe(1);
    expect(first.read()).toBe(0);
    first.bump();
    expect(first.read()).toBe(1);
    controller.getRevision("tab-2");
    expect(created).toBe(2);
  });

  it("eagerly creates the revision counter on register", () => {
    let created = 0;
    const controller = createDocumentController({ createRevision: () => { created += 1; return createCounter(); } });
    controller.register("tab-1", handle("live"));
    expect(created).toBe(1);
  });

  it("retains a read-only dirty buffer across editor unmount and releases it only with its tab", () => {
    const controller = createDocumentController({ createRevision: createCounter });
    const retained = handle("edited\ndirty text", "c");
    controller.register("tab-1", retained);
    const revision = controller.getRevision("tab-1");
    const cacheBytesBeforeDetach = controller.getCacheBytes();

    controller.unregister("tab-1", retained);
    expect(controller.getActiveHandle("tab-1")).toBeUndefined();
    expect(controller.getHandle("tab-1")).toBe(retained);
    expect(controller.getText(tab())).toBe("edited\ndirty text");
    expect(controller.getHandle("tab-1")?.getRange(0, 6)).toBe("edited");
    expect(controller.getHandle("tab-1")?.getSnapshot()).toEqual(expect.objectContaining({
      content: "edited\ndirty text",
      revision: 2,
      lineEndings: "c",
    }));
    expect(controller.getCachedDocument("tab-1")?.content).toBe("edited\ndirty text");
    expect(controller.getCachedDocument("tab-1")?.lineEndings).toBe("c");
    expect(controller.getCacheBytes()).toBe(cacheBytesBeforeDetach);
    expect(controller.getCachedDocument("tab-1")?.savedContent).toBe("disk baseline");
    expect(controller.getRevision("tab-1")).toBe(revision);

    controller.register("tab-1", handle("reconstructed"));
    expect(controller.getCachedDocument("tab-1")).toBeUndefined();
    expect(controller.getActiveHandle("tab-1")?.getText()).toBe("reconstructed");
    controller.unregister("tab-1", retained);
    controller.release("tab-1");
    expect(controller.getHandle("tab-1")).toBeUndefined();
    const fresh = controller.getRevision("tab-1");
    expect(fresh).not.toBe(revision);
  });

  it("releases only a clean history-free cache after the owner reconciles its exact current seed", () => {
    const controller = createDocumentController({ createRevision: createCounter });
    const current = "saved after undo\nline two";
    const currentSeed = seed(current, "c");
    Object.assign(currentSeed, {
      savedContent: current,
      savedLineEndings: "c",
      revision: 12,
      savedRevision: 12,
      estimatedBytes: current.length + 1,
    });
    const retained = handle(current, "c", {
      lastUsed: 5,
      dirty: false,
      hasUndoHistory: false,
      canRelease: true,
    }, currentSeed);
    controller.register("tab-1", retained);
    controller.unregister("tab-1", retained);

    let restoredFallback = tab({
      id: "tab-1",
      content: "stale App content",
      savedContent: "stale App content",
      dirty: false,
    });
    const status = controller.enforceCacheBudget(0, (tabId, document) => {
      expect(tabId).toBe("tab-1");
      expect(document).toEqual(currentSeed);
      restoredFallback = tab({
        id: tabId,
        content: document.content,
        lineEndings: document.lineEndings,
        lineEnding: document.lineEnding,
        savedContent: document.savedContent,
        savedLineEndings: document.savedLineEndings,
        bom: document.bom,
        savedBom: document.savedBom,
        encoding: document.encoding,
        revision: document.revision,
        savedRevision: document.savedRevision,
        dirty: false,
      });
      return true;
    });

    expect(status.evictedTabIds).toEqual(["tab-1"]);
    expect(status.evictedDocuments).toEqual([{ tabId: "tab-1", document: currentSeed }]);
    expect(status.estimatedBytes).toBe(0);
    expect(status.overBudget).toBe(false);
    expect(controller.getHandle("tab-1")).toBeUndefined();
    expect(controller.getText(restoredFallback)).toBe(current);
    expect(restoredFallback.lineEndings).toBe("c");
    expect(restoredFallback.savedContent).toBe(current);
  });

  it("keeps dirty and Undo/Redo-protected retained documents over budget", () => {
    const controller = createDocumentController({ createRevision: createCounter });
    const dirty = handle("dirty text", "", {
      lastUsed: 1,
      dirty: true,
      hasUndoHistory: false,
      canRelease: false,
    });
    const cleanWithUndo = handle("clean text", "", {
      lastUsed: 2,
      dirty: false,
      hasUndoHistory: true,
      canRelease: false,
    });
    controller.register("dirty", dirty);
    controller.register("undo", cleanWithUndo);
    controller.unregister("dirty", dirty);
    controller.unregister("undo", cleanWithUndo);

    let confirmed = 0;
    const status = controller.enforceCacheBudget(0, () => {
      confirmed += 1;
      return true;
    });

    expect(confirmed).toBe(0);
    expect(status.evictedTabIds).toEqual([]);
    expect(status.overBudget).toBe(true);
    expect(status.estimatedBytes).toBeGreaterThan(0);
    expect(controller.getText(tab({ id: "dirty" }))).toBe("dirty text");
    expect(controller.getText(tab({ id: "undo" }))).toBe("clean text");
  });

  it("includes owner-held tab strings in the budget while protecting retained history", () => {
    let ownerBytes = 0;
    const controller = createDocumentController({
      createRevision: createCounter,
      getAdditionalCacheBytes: () => ownerBytes,
    });
    const cleanWithUndo = handle("clean text", "", {
      lastUsed: 1,
      dirty: false,
      hasUndoHistory: true,
      canRelease: false,
    });
    controller.register("tab-1", cleanWithUndo);
    controller.unregister("tab-1", cleanWithUndo);

    const documentBytes = controller.getCacheBytes();
    ownerBytes = 4096;
    let evictionConfirmed = false;
    const status = controller.enforceCacheBudget(documentBytes, () => {
      evictionConfirmed = true;
      return true;
    });

    expect(status.estimatedBytes).toBe(documentBytes + ownerBytes);
    expect(status.overBudget).toBe(true);
    expect(status.evictedTabIds).toEqual([]);
    expect(evictionConfirmed).toBe(false);
    expect(controller.getHandle("tab-1")).toBe(cleanWithUndo);
  });

  it("does not evict a clean document unless the owner confirms its fallback update", () => {
    const controller = createDocumentController({ createRevision: createCounter });
    const clean = handle("current", "", {
      dirty: false,
      hasUndoHistory: false,
      canRelease: true,
    }, { savedContent: "current", savedLineEndings: "" });
    controller.register("tab-1", clean);
    controller.unregister("tab-1", clean);

    expect(controller.enforceCacheBudget(0).evictedTabIds).toEqual([]);
    const status = controller.enforceCacheBudget(0, () => false);
    expect(status.evictedTabIds).toEqual([]);
    expect(status.overBudget).toBe(true);
    expect(controller.getText(tab())).toBe("current");
  });

  it("keeps a clean document retained when its selection exceeds the fallback bound", () => {
    const controller = createDocumentController({ createRevision: createCounter });
    const clean = handle("current", "", {
      dirty: false,
      hasUndoHistory: false,
      canRelease: true,
    }, {
      savedContent: "current",
      savedLineEndings: "",
      selectionJSON: {
        main: 0,
        ranges: Array.from({ length: 65 }, () => ({ anchor: 1, head: 1 })),
      },
    });
    controller.register("tab-1", clean);
    controller.unregister("tab-1", clean);

    const status = controller.enforceCacheBudget(0, (_tabId, document) => Boolean(
      createEditorSelectionFallback(document.selectionJSON, document.revision, document.sourceVersion, document.content.length),
    ));

    expect(status.evictedTabIds).toEqual([]);
    expect(status.overBudget).toBe(true);
    expect(controller.getHandle("tab-1")).toBe(clean);
  });

  it("clears all handles and revisions on dispose", () => {
    const controller = createDocumentController({ createRevision: createCounter });
    controller.register("tab-1", handle("live"));
    controller.register("tab-2", handle("other"));
    controller.dispose();
    expect(controller.getHandle("tab-1")).toBeUndefined();
    expect(controller.getHandle("tab-2")).toBeUndefined();
    expect(controller.getText(tab())).toBe("fallback");
    expect(controller.getCacheBytes()).toBe(0);
  });
});
