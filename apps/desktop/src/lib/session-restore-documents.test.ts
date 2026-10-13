import { describe, expect, it, vi } from "vitest";
import type { PersistedTab, RecoverySnapshot } from "./session-storage-schema";
import type { EditorTab, ReadFileResult } from "../types";
import { normalizeDocumentContent, normalizeLineEndingMap, lineEndingFromMap } from "./file-metadata";
import { recoveryStorageKey } from "./session-storage-schema";
import { restorePersistedTab, type SessionRestoreDocumentDependencies } from "./session-restore-documents";
import * as sessionStorage from "./session-storage";

const scope = "restore-documents-test";
const tabId = "restore-tab";
const path = "/workspace/example.ts";

function persistedTab(overrides: Partial<PersistedTab> = {}): PersistedTab {
  return {
    id: tabId,
    path,
    name: "example.ts",
    dirty: true,
    lineEnding: "lf",
    encoding: "UTF-8",
    language: "TypeScript",
    cursorLine: 2,
    cursorColumn: 3,
    revision: 2,
    savedRevision: 1,
    contentVersion: 2,
    ...overrides,
  };
}

function recoverySnapshot(overrides: Partial<RecoverySnapshot> = {}): RecoverySnapshot {
  return {
    version: 1,
    tabId,
    path,
    revision: 2,
    content: "edited\r\nline",
    savedContent: "saved\r\nline",
    lineEnding: "lf",
    lineEndings: "c",
    savedLineEndings: "c",
    bom: true,
    savedBom: true,
    encoding: "UTF-8 BOM",
    ...overrides,
  };
}

function diskFile(overrides: Partial<ReadFileResult> = {}): ReadFileResult {
  return {
    path,
    content: "saved\nline",
    encoding: "utf-8",
    lineEnding: "lf",
    lineEndings: "l",
    bom: false,
    modifiedAt: 100,
    size: 10,
    fingerprint: "disk-fingerprint",
    identity: "disk-identity",
    ...overrides,
  };
}

function dependencies(readDocument: (filePath: string) => Promise<ReadFileResult>): SessionRestoreDocumentDependencies {
  return {
    isCurrent: () => true,
    readDocument,
    normalizeReadFile(file) {
      const content = normalizeDocumentContent(file.content);
      const lineEndings = normalizeLineEndingMap(content, file.lineEndings, file.lineEnding);
      return { ...file, content, lineEndings, lineEnding: lineEndingFromMap(lineEndings, file.lineEnding), bom: file.bom === true };
    },
    createImageTab(imagePath, size): EditorTab {
      return {
        id: "new-image-id",
        path: imagePath,
        name: "image.png",
        content: "",
        savedContent: "",
        dirty: false,
        lineEnding: "lf",
        lineEndings: "",
        savedLineEndings: "",
        bom: false,
        savedBom: false,
        encoding: "UTF-8",
        language: "Image",
        cursorLine: 1,
        cursorColumn: 1,
        revision: 0,
        savedRevision: 0,
        contentVersion: 0,
        diskSize: size,
      };
    },
  };
}

describe("session restore documents", () => {
  it("retains dirty recovery text, BOM and per-line ending maps", async () => {
    const snapshot = recoverySnapshot();
    const readDocument = vi.fn(async () => diskFile());
    const result = await restorePersistedTab(
      persistedTab(),
      { cursorLine: 3, cursorColumn: 4 },
      scope,
      { [recoveryStorageKey(tabId, scope)]: snapshot },
      dependencies(readDocument),
    );

    expect(readDocument).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ diskChangedSinceRecovery: true, orphaned: false, tab: {
      id: tabId,
      content: "edited\nline",
      savedContent: "saved\nline",
      dirty: true,
      lineEndings: "c",
      savedLineEndings: "c",
      bom: true,
      savedBom: true,
      encoding: "UTF-8 BOM",
      cursorLine: 3,
      cursorColumn: 4,
      normalizedContentVersion: 2,
      normalizedSavedRevision: 1,
    } });
  });

  it("uses matching recovery content when the original file is missing", async () => {
    const result = await restorePersistedTab(
      persistedTab(),
      undefined,
      scope,
      { [recoveryStorageKey(tabId, scope)]: recoverySnapshot() },
      dependencies(async () => { throw new Error("Unable to read file. missing (os error 2)"); }),
    );

    expect(result).toMatchObject({ diskChangedSinceRecovery: false, orphaned: true, tab: {
      content: "edited\nline",
      savedContent: "saved\nline",
      dirty: true,
      bom: true,
      savedBom: true,
    } });
  });

  it("keeps a non-missing body read failure observable instead of fabricating a tab", async () => {
    const failure = new Error("permission denied");
    const result = await restorePersistedTab(
      persistedTab(),
      undefined,
      scope,
      { [recoveryStorageKey(tabId, scope)]: recoverySnapshot() },
      dependencies(async () => { throw failure; }),
    );

    expect(result).toEqual({ status: "read-failed", tabId, path, error: failure });
  });

  it("drops stale restore work before body reads or recovery cleanup", async () => {
    const readDocument = vi.fn(async () => diskFile());
    const result = await restorePersistedTab(
      persistedTab({ savedRevision: 9 }),
      undefined,
      scope,
      { [recoveryStorageKey(tabId, scope)]: recoverySnapshot({ revision: 3 }) },
      { ...dependencies(readDocument), isCurrent: () => false },
    );

    expect(result).toBeNull();
    expect(readDocument).not.toHaveBeenCalled();
  });

  it("keeps a dirty legacy tab pending when recovery storage is unavailable, then retries the exact snapshot", async () => {
    const snapshot = recoverySnapshot({ content: "original unread\r\nbody", lineEndings: "cc", bom: true, encoding: "UTF-8 BOM" });
    const recoveryRead = vi.spyOn(sessionStorage, "readRecoveryStorageResult")
      .mockResolvedValue({ status: "unavailable", error: new Error("temporary IDB fault"), observedValue: snapshot });
    const readDocument = vi.fn(async () => diskFile());
    const deps = dependencies(readDocument);
    const first = await restorePersistedTab(persistedTab(), undefined, scope, undefined, deps);
    expect(first).toMatchObject({ status: "read-failed", tabId, path });
    expect(readDocument).not.toHaveBeenCalled();

    recoveryRead.mockResolvedValue({ status: "available", value: snapshot });
    const retried = await restorePersistedTab(persistedTab(), undefined, scope, undefined, deps);
    expect(retried).toMatchObject({ tab: { content: "original unread\nbody", dirty: true, bom: true, encoding: "UTF-8 BOM" } });
    expect(readDocument).toHaveBeenCalledOnce();
  });

  it("also blocks a clean legacy row when recovery may contain a newer dirty snapshot", async () => {
    const snapshot = recoverySnapshot({ content: "newer uncommitted text", revision: 5 });
    const recoveryRead = vi.spyOn(sessionStorage, "readRecoveryStorageResult")
      .mockResolvedValue({ status: "unavailable", error: new Error("temporary IDB fault"), observedValue: snapshot });
    const cleanPersisted = persistedTab({ dirty: false, revision: 2, savedRevision: 1 });
    const readDocument = vi.fn(async () => diskFile());
    const deps = dependencies(readDocument);

    const first = await restorePersistedTab(cleanPersisted, undefined, scope, undefined, deps);
    expect(first).toMatchObject({ status: "read-failed", recoveryUnavailable: true });
    expect(readDocument).not.toHaveBeenCalled();

    recoveryRead.mockResolvedValue({ status: "available", value: snapshot });
    const retried = await restorePersistedTab(cleanPersisted, undefined, scope, undefined, deps);
    expect(retried).toMatchObject({ tab: { content: "newer uncommitted text", dirty: true } });
    expect(readDocument).toHaveBeenCalledOnce();
  });

  it("keeps v2 recovery pending when its baseline is unreadable but permits a confirmed missing baseline to use disk", async () => {
    const snapshot = recoverySnapshot({
      version: 2,
      savedContent: "",
      savedContentUnavailable: true,
      savedRevision: 1,
    });
    const recoveryRead = vi.spyOn(sessionStorage, "readRecoveryStorageResult")
      .mockResolvedValue({ status: "available", value: snapshot });
    const baselineRead = vi.spyOn(sessionStorage, "readRecoveryBaselineResult")
      .mockResolvedValue({ status: "unavailable", error: new Error("temporary baseline fault") });
    const readDocument = vi.fn(async () => diskFile());
    const deps = dependencies(readDocument);

    const first = await restorePersistedTab(persistedTab(), undefined, scope, undefined, deps);
    expect(first).toMatchObject({ status: "read-failed" });
    expect(readDocument).not.toHaveBeenCalled();

    baselineRead.mockResolvedValue({ status: "missing" });
    const retried = await restorePersistedTab(persistedTab(), undefined, scope, undefined, deps);
    expect(retried).toMatchObject({ tab: { content: "edited\nline", savedContent: "saved\nline", dirty: true } });
    expect(readDocument).toHaveBeenCalledOnce();
    expect(recoveryRead).toHaveBeenCalledTimes(2);
  });

  it("restores image metadata without opening a text document", async () => {
    const readDocument = vi.fn(async () => diskFile());
    const result = await restorePersistedTab(
      persistedTab({ path: "/workspace/preview.png", name: "preview.png", diskSize: 55 }),
      { cursorLine: 8, cursorColumn: 2 },
      scope,
      undefined,
      dependencies(readDocument),
    );

    expect(readDocument).not.toHaveBeenCalled();
    expect(result).toMatchObject({ orphaned: false, tab: {
      id: tabId,
      path: "/workspace/preview.png",
      diskSize: 55,
      cursorLine: 8,
      cursorColumn: 2,
      language: "Image",
    } });
  });
});
