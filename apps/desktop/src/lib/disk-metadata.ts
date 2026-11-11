import type { EditorTab, ReadFileResult } from "../types";
import type { StatFileEntry } from "./bridge";

export function diskMetadataChanged(tab: EditorTab, entry?: StatFileEntry): boolean {
  return !entry
    || entry.modifiedAt === null
    || entry.modifiedAt !== tab.diskModifiedAt
    || entry.size === null
    || entry.size !== tab.diskSize
    || entry.identity === null
    || entry.identity !== tab.diskIdentity;
}

/** Replace the tab's buffer and saved baseline with the version just read from disk. */
export function adoptDiskVersionChanges(current: EditorTab, file: ReadFileResult): Partial<EditorTab> {
  const revision = current.revision + 1;
  return {
    content: file.content,
    savedContent: file.content,
    dirty: false,
    orphaned: false,
    lineEnding: file.lineEnding,
    lineEndings: file.lineEndings,
    savedLineEndings: file.lineEndings,
    bom: file.bom,
    savedBom: file.bom,
    encoding: file.encoding === "utf-8-bom" ? "UTF-8 BOM" : "UTF-8",
    revision,
    savedRevision: revision,
    contentVersion: current.contentVersion + 1,
    normalizedContentVersion: current.contentVersion + 1,
    normalizedSavedRevision: revision,
    diskModifiedAt: file.modifiedAt,
    diskSize: file.size,
    estimatedBytes: file.size,
    diskFingerprint: file.fingerprint,
    diskIdentity: file.identity ?? undefined,
    largeFile: file.size > 5 * 1024 * 1024,
  };
}
