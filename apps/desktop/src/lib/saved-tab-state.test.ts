import { describe, expect, it } from "vitest";
import type { EditorTab } from "../types";
import { createSaveController, type SaveFileOutcome, type SaveSnapshot } from "./save-controller";
import { savedTabChanges } from "./saved-tab-state";

const initialText = "alpha\nbeta\ngamma\n";
const savedText = "alpha\nbeta QA\ngamma\n";

const tab = (overrides: Partial<EditorTab> = {}): EditorTab => ({
  id: "tab-1",
  path: "/workspace/alpha.txt",
  name: "alpha.txt",
  content: initialText,
  savedContent: initialText,
  dirty: true,
  lineEnding: "lf",
  lineEndings: "lll",
  savedLineEndings: "lll",
  bom: false,
  savedBom: false,
  encoding: "UTF-8",
  language: "Plain Text",
  cursorLine: 1,
  cursorColumn: 1,
  revision: 2,
  savedRevision: 0,
  contentVersion: 4,
  ...overrides,
});

const snapshot = (overrides: Partial<SaveSnapshot> = {}): SaveSnapshot => ({
  tabId: "tab-1",
  path: "/workspace/alpha.txt",
  content: savedText,
  lineEnding: "lf",
  lineEndings: "lll",
  bom: false,
  encoding: "UTF-8",
  revision: 2,
  ...overrides,
});

describe("saved tab state", () => {
  it("reopens a clean tab from the accepted save after the editor cache is recreated", async () => {
    let current = tab();
    const accepted = snapshot();
    const controller = createSaveController({
      saveFile: async () => ({ modifiedAt: 20, size: savedText.length, fingerprint: "saved-fingerprint" }),
      onSaved: (saved, result) => {
        current = {
          ...current,
          ...savedTabChanges(current, saved, { content: saved.content, lineEndings: saved.lineEndings }, result),
        };
      },
    });

    expect((await controller.enqueue(accepted)).ok).toBe(true);

    // A newly created EditorPane has no local cache and seeds from tab.content.
    const remountedEditorText = current.content;
    expect(remountedEditorText).toBe(savedText);
    expect(current.savedContent).toBe(savedText);
    expect(current.dirty).toBe(false);
    expect(current.contentVersion).toBe(4);
    expect(current.normalizedContentVersion).toBe(4);
    expect(current.normalizedSavedRevision).toBe(2);
  });

  it("keeps a newer dirty editor buffer authoritative when an older in-flight save completes", async () => {
    let current = tab();
    const accepted = snapshot();
    let liveDocument = { content: accepted.content, lineEndings: accepted.lineEndings };
    let completeSave!: (result: SaveFileOutcome) => void;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    const controller = createSaveController({
      saveFile: async () => {
        markSaveStarted();
        return await new Promise<SaveFileOutcome>((resolve) => { completeSave = resolve; });
      },
      onSaved: (saved, result) => {
        current = {
          ...current,
          ...savedTabChanges(current, saved, liveDocument, result),
        };
      },
    });
    const pending = controller.enqueue(accepted);
    await saveStarted;

    // A newer edit lands after the write snapshot is accepted but before it completes.
    const newerText = "alpha\nbeta newer\ngamma\n";
    liveDocument = { content: newerText, lineEndings: "lll" };
    current = { ...current, revision: 3, dirty: true };
    completeSave({ modifiedAt: 20, size: savedText.length, fingerprint: "saved-fingerprint" });
    expect((await pending).ok).toBe(true);

    expect(current).toMatchObject({ content: newerText, savedContent: savedText, dirty: true, revision: 3, savedRevision: 2, contentVersion: 4, normalizedSavedRevision: 2 });
    expect(current.normalizedContentVersion).toBeUndefined();
    expect(liveDocument.content).toBe(newerText);
  });

  it("keeps canonical line-ending and encoding changes dirty across a successful save", async () => {
    let current = tab({
      content: savedText,
      savedContent: savedText,
      lineEndings: "clc",
      savedLineEndings: "lll",
      encoding: "UTF-8 BOM",
    });
    const accepted = snapshot({ content: savedText, lineEndings: "lll", encoding: "UTF-8" });
    const controller = createSaveController({
      saveFile: async () => ({ modifiedAt: 20, size: savedText.length, fingerprint: "saved-fingerprint" }),
      onSaved: (saved, result) => {
        current = {
          ...current,
          ...savedTabChanges(current, saved, { content: savedText, lineEndings: "clc" }, result),
        };
      },
    });

    expect((await controller.enqueue(accepted)).ok).toBe(true);
    expect(current).toMatchObject({
      content: savedText,
      savedContent: savedText,
      lineEndings: "clc",
      savedLineEndings: "lll",
      encoding: "UTF-8 BOM",
      dirty: true,
      normalizedSavedRevision: 2,
    });
    expect(current.normalizedContentVersion).toBeUndefined();
  });
});
