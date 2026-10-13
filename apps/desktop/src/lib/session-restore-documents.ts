import type { CursorPosition, PersistedTab, RecoverySnapshot } from "./session-storage-schema";
import type { EditorTab, ReadFileResult } from "../types";
import {
  fileLanguageForPath,
  isImagePath,
  lineEndingFromMap,
  lineEndingMapForContent,
  normalizeDocumentContent,
  normalizeLineEndingMap,
} from "./file-metadata";
import {
  parseRecovery,
  parseRecoveryBaseline,
  readRecoveryBaselineResult,
  readRecoveryStorageResult,
  recoveryBaselineKey,
  recoveryStorageKey,
  removeRecoveryStorage,
  resolveRecoveryBaseline,
} from "./session-storage";
import { isMissingFileReadError, readFileForRestore } from "./restore-file-read";
import { pathComparisonKey, runtimePathOptions, wireBasename } from "./path-identity";

export type RestoredTabRecord = {
  tab: EditorTab;
  diskChangedSinceRecovery: boolean;
  orphaned: boolean;
};

export type RestoreTabReadFailure = { status: "read-failed"; tabId: string; path: string; error: unknown; recoveryUnavailable?: true };
export type RestoredTabResult = RestoredTabRecord | RestoreTabReadFailure;

export type SessionRestoreDocumentDependencies = {
  readDocument: (path: string) => Promise<ReadFileResult>;
  /** The App's shared normalizer preserves its canonical-read WeakSet boundary. */
  normalizeReadFile: (file: ReadFileResult) => ReadFileResult;
  createImageTab: (path: string, size?: number) => EditorTab;
  isCurrent: () => boolean;
};

const normalizedRecoverySnapshots = new WeakSet<RecoverySnapshot>();
const pathOptions = runtimePathOptions();

/** Restore document metadata and recovery text only after startup selects tabs. */
export async function restorePersistedTab(
  persistedTab: PersistedTab,
  cursor: CursorPosition | undefined,
  sessionScope: string,
  checkpointRecoveries: Readonly<Record<string, RecoverySnapshot>> | undefined,
  dependencies: SessionRestoreDocumentDependencies,
): Promise<RestoredTabResult | null> {
  if (!dependencies.isCurrent()) return null;
  if (isImagePath(persistedTab.path)) {
    return { tab: makeImageTabFromMetadata(persistedTab, cursor, dependencies.createImageTab), diskChangedSinceRecovery: false, orphaned: false };
  }
  let recoveryValue: unknown;
  if (checkpointRecoveries) {
    recoveryValue = checkpointRecoveries[recoveryStorageKey(persistedTab.id, sessionScope)] ?? null;
  } else {
    let recoveryRead;
    try {
      recoveryRead = await readRecoveryStorageResult(recoveryStorageKey(persistedTab.id, sessionScope));
    } catch (error) {
      return { status: "read-failed", tabId: persistedTab.id, path: persistedTab.path, error, recoveryUnavailable: true };
    }
    if (!dependencies.isCurrent()) return null;
    if (recoveryRead.status === "unavailable") {
      return {
        status: "read-failed",
        tabId: persistedTab.id,
        path: persistedTab.path,
        error: recoveryRead.error ?? new Error("Recovery storage is unavailable; this tab is retained for retry."),
        recoveryUnavailable: true,
      };
    }
    recoveryValue = recoveryRead.status === "available" ? recoveryRead.value : null;
  }
  if (!dependencies.isCurrent()) return null;
  const parsedRecovery = parseRecovery(recoveryValue);
  let recovery = parsedRecovery ? normalizeRecoverySnapshot(parsedRecovery) : null;
  if (!checkpointRecoveries && recovery?.version === 2 && recovery.savedContentUnavailable) {
    // Checkpoint recoveries already resolved their baselines at read time;
    // standalone per-tab values resolve theirs here.
    let baselineRead;
    try {
      baselineRead = await readRecoveryBaselineResult(recoveryBaselineKey(persistedTab.id, sessionScope));
    } catch (error) {
      return { status: "read-failed", tabId: persistedTab.id, path: persistedTab.path, error, recoveryUnavailable: true };
    }
    if (!dependencies.isCurrent()) return null;
    if (baselineRead.status === "unavailable") {
      return {
        status: "read-failed",
        tabId: persistedTab.id,
        path: persistedTab.path,
        error: baselineRead.error ?? new Error("Recovery baseline storage is unavailable; this tab is retained for retry."),
        recoveryUnavailable: true,
      };
    }
    const baselineRaw = baselineRead.status === "available" ? baselineRead.value : null;
    const withBaseline = resolveRecoveryBaseline(recovery, parseRecoveryBaseline(baselineRaw));
    recovery = withBaseline
      ? normalizeRecoverySnapshot(withBaseline, withBaseline !== recovery, recovery !== null && normalizedRecoverySnapshots.has(recovery))
      : null;
  }
  const matchingRecovery = recovery && samePath(recovery.path, persistedTab.path) && recovery.tabId === persistedTab.id ? recovery : null;
  if (!dependencies.isCurrent()) return null;
  const readResult = await readFileForRestore(
    () => dependencies.readDocument(persistedTab.path).then(dependencies.normalizeReadFile),
    (error) => isMissingFileReadError(error, pathOptions.platform ?? "posix"),
  );
  if (!dependencies.isCurrent()) return null;
  if (readResult.status === "read-failed") return { ...readResult, tabId: persistedTab.id, path: persistedTab.path };
  const disk = readResult.status === "available" ? readResult.file : undefined;
  if (!disk && !matchingRecovery) {
    const tab = makeTabFromMetadata(persistedTab, "", "", persistedTab.lineEnding, cursor, undefined, undefined, dependencies.normalizeReadFile);
    return { tab: persistedTab.dirty ? { ...tab, dirty: true } : tab, diskChangedSinceRecovery: false, orphaned: true };
  }
  // A checkpoint newer than the persisted save point is the only safe
  // recovery candidate, including when the file is currently missing.
  // Older checkpoints can otherwise resurrect edits that were already
  // saved before a crash.
  const usableRecovery = matchingRecovery && matchingRecovery.revision > persistedTab.savedRevision ? matchingRecovery : null;
  if (matchingRecovery && !usableRecovery) {
    // Do not retain a checkpoint that can never be selected. Besides wasting
    // quota, a stale orphan checkpoint would be reconsidered on every launch.
    if (dependencies.isCurrent()) void removeRecoveryStorage(recoveryStorageKey(persistedTab.id, sessionScope));
  }
  const content = usableRecovery?.content ?? disk?.content ?? "";
  const recoveredSavedContent = usableRecovery?.savedContentUnavailable ? disk?.content ?? "" : usableRecovery?.savedContent;
  const savedContent = recoveredSavedContent ?? disk?.content ?? content;
  const tab = makeTabFromMetadata(
    persistedTab,
    content,
    savedContent,
    usableRecovery?.lineEnding ?? disk?.lineEnding ?? persistedTab.lineEnding,
    cursor,
    disk,
    usableRecovery ?? undefined,
    dependencies.normalizeReadFile,
  );
  return {
    // Preserve the dirty marker when a checkpoint is unavailable. The
    // document text cannot be recovered, but silently presenting the
    // disk copy as clean would hide a possible lost edit.
    tab: persistedTab.dirty && !usableRecovery ? { ...tab, dirty: true } : tab,
    diskChangedSinceRecovery: Boolean(usableRecovery && disk && (usableRecovery.savedContentUnavailable
      ? (persistedTab.diskFingerprint && disk.fingerprint
        ? persistedTab.diskFingerprint !== disk.fingerprint
        : persistedTab.diskModifiedAt !== undefined || persistedTab.diskSize !== undefined
          ? persistedTab.diskModifiedAt !== disk.modifiedAt || persistedTab.diskSize !== disk.size
          : true)
      : disk.content !== usableRecovery.savedContent
        || disk.encoding !== (usableRecovery.encoding === "UTF-8 BOM" ? "utf-8-bom" : "utf-8")
        || Boolean(disk.bom) !== Boolean(usableRecovery.savedBom)
        || disk.lineEndings !== usableRecovery.savedLineEndings)),
    orphaned: !disk,
  };
}

export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()));
  return results;
}

function makeImageTabFromMetadata(persisted: PersistedTab, cursor: CursorPosition | undefined, createImageTab: SessionRestoreDocumentDependencies["createImageTab"]): EditorTab {
  return {
    ...createImageTab(persisted.path, persisted.diskSize),
    id: persisted.id,
    pinned: persisted.pinned === true,
    cursorLine: cursor?.cursorLine ?? persisted.cursorLine,
    cursorColumn: cursor?.cursorColumn ?? persisted.cursorColumn,
    revision: persisted.revision,
    savedRevision: persisted.savedRevision,
    contentVersion: persisted.contentVersion,
    diskModifiedAt: persisted.diskModifiedAt,
    diskSize: persisted.diskSize,
    diskFingerprint: persisted.diskFingerprint,
    diskIdentity: persisted.diskIdentity,
  };
}

function makeTabFromMetadata(
  persisted: PersistedTab,
  content: string,
  savedContent: string,
  lineEnding: ReadFileResult["lineEnding"],
  cursor: CursorPosition | undefined,
  disk: ReadFileResult | undefined,
  recovery: RecoverySnapshot | undefined,
  normalizeReadFile: SessionRestoreDocumentDependencies["normalizeReadFile"],
): EditorTab {
  const normalizedDisk = disk ? normalizeReadFile(disk) : undefined;
  const normalizedRecovery = recovery ? normalizeRecoverySnapshot(recovery) : undefined;
  const contentIsKnown = (normalizedRecovery !== undefined && content === normalizedRecovery.content)
    || (normalizedDisk !== undefined && content === normalizedDisk.content);
  const normalizedContent = contentIsKnown ? content : normalizeDocumentContent(content);
  const savedContentIsKnown = savedContent === content
    || (normalizedRecovery !== undefined && savedContent === normalizedRecovery.savedContent)
    || (normalizedDisk !== undefined && savedContent === normalizedDisk.content);
  const normalizedSavedContent = savedContent === content
    ? normalizedContent
    : savedContentIsKnown ? savedContent : normalizeDocumentContent(savedContent);
  const preferred = normalizedRecovery?.lineEnding ?? normalizedDisk?.lineEnding ?? persisted.lineEnding ?? lineEnding;
  const lineEndingsSource = normalizedRecovery?.lineEndings ?? normalizedDisk?.lineEndings ?? persisted.lineEndings;
  const currentMapIsKnown = (normalizedRecovery !== undefined && lineEndingsSource === normalizedRecovery.lineEndings)
    || (normalizedDisk !== undefined && lineEndingsSource === normalizedDisk.lineEndings);
  const lineEndings = contentIsKnown && currentMapIsKnown && typeof lineEndingsSource === "string"
    ? lineEndingsSource
    : normalizeLineEndingMap(normalizedContent, lineEndingsSource, preferred);
  const savedLineEndingsSource = normalizedRecovery && !normalizedRecovery.savedContentUnavailable && normalizedSavedContent === normalizedRecovery.savedContent
    ? normalizedRecovery.savedLineEndings
    : normalizedDisk && normalizedSavedContent === normalizedDisk.content
      ? normalizedDisk.lineEndings
      : persisted.savedLineEndings ?? lineEndings;
  const savedMapIsKnown = (normalizedRecovery !== undefined
    && !normalizedRecovery.savedContentUnavailable
    && normalizedSavedContent === normalizedRecovery.savedContent
    && savedLineEndingsSource === normalizedRecovery.savedLineEndings)
    || (normalizedDisk !== undefined && normalizedSavedContent === normalizedDisk.content && savedLineEndingsSource === normalizedDisk.lineEndings);
  const savedLineEndings = normalizedSavedContent === normalizedContent && savedLineEndingsSource === lineEndings
    ? lineEndings
    : savedMapIsKnown && typeof savedLineEndingsSource === "string"
      ? savedLineEndingsSource
      : normalizeLineEndingMap(normalizedSavedContent, savedLineEndingsSource, preferred);
  const bom = normalizedRecovery?.bom ?? normalizedDisk?.bom ?? persisted.bom ?? false;
  const savedBom = normalizedRecovery?.savedBom ?? normalizedDisk?.bom ?? persisted.savedBom ?? bom;
  const encoding = normalizedRecovery?.encoding ?? (normalizedDisk?.encoding === "utf-8-bom" ? "UTF-8 BOM" : persisted.encoding ?? "UTF-8");
  const savedEncoding = normalizedDisk
    ? normalizedDisk.encoding === "utf-8-bom" ? "UTF-8 BOM" : "UTF-8"
    : persisted.encoding;
  return {
    id: persisted.id,
    path: persisted.path,
    name: wireBasename(persisted.path, pathOptions),
    pinned: persisted.pinned === true,
    content: normalizedContent,
    savedContent: normalizedSavedContent,
    dirty: normalizedContent !== normalizedSavedContent
      || lineEndings !== savedLineEndings
      || bom !== savedBom
      || encoding !== savedEncoding,
    lineEnding: lineEndingFromMap(lineEndings, preferred),
    lineEndings,
    savedLineEndings,
    bom,
    savedBom,
    encoding,
    language: fileLanguageForPath(persisted.path).label,
    cursorLine: cursor?.cursorLine ?? persisted.cursorLine,
    cursorColumn: cursor?.cursorColumn ?? persisted.cursorColumn,
    revision: persisted.revision,
    savedRevision: persisted.savedRevision,
    contentVersion: persisted.contentVersion,
    normalizedContentVersion: persisted.contentVersion,
    normalizedSavedRevision: persisted.savedRevision,
    diskModifiedAt: normalizedDisk?.modifiedAt ?? persisted.diskModifiedAt,
    diskSize: normalizedDisk?.size ?? persisted.diskSize,
    diskFingerprint: normalizedDisk?.fingerprint ?? persisted.diskFingerprint,
    diskIdentity: normalizedDisk?.identity ?? persisted.diskIdentity,
    largeFile: Math.max(normalizedDisk?.size ?? 0, persisted.diskSize ?? 0, normalizedContent.length, normalizedSavedContent.length) > 5 * 1024 * 1024,
  };
}

function normalizeRecoverySnapshot(recovery: RecoverySnapshot, validateSavedBaseline = false, currentAlreadyNormalized = false): RecoverySnapshot {
  if (normalizedRecoverySnapshots.has(recovery) && !validateSavedBaseline) return recovery;
  const lineEnding = recovery.lineEnding;
  const currentIsKnown = currentAlreadyNormalized || normalizedRecoverySnapshots.has(recovery);
  const content = currentIsKnown ? recovery.content : normalizeDocumentContent(recovery.content);
  const savedContent = recovery.savedContent === recovery.content
    ? content
    : !validateSavedBaseline && normalizedRecoverySnapshots.has(recovery)
      ? recovery.savedContent
      : normalizeDocumentContent(recovery.savedContent);
  const lineEndings = recovery.lineEndings ?? lineEndingMapForContent(content, lineEnding);
  const savedLineEndings = validateSavedBaseline
    ? normalizeLineEndingMap(savedContent, recovery.savedLineEndings, lineEnding)
    : recovery.savedLineEndings ?? lineEndingMapForContent(savedContent, lineEnding);
  const normalized = { ...recovery, content, savedContent, lineEndings, savedLineEndings };
  normalizedRecoverySnapshots.add(normalized);
  return normalized;
}

function samePath(left: string, right: string): boolean {
  return pathComparisonKey(left, pathOptions) === pathComparisonKey(right, pathOptions);
}
