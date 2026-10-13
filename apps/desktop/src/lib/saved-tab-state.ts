import type { EditorTab } from "../types";
import type { SaveFileOutcome, SaveSnapshot } from "./save-controller";

export type LiveDocumentState = {
  content: string;
  lineEndings: string;
};

/**
 * Apply the durable baseline from a successful save without replacing a newer
 * editor buffer that changed while that save was in flight.
 */
export function savedTabChanges(
  current: EditorTab,
  snapshot: SaveSnapshot,
  liveDocument: LiveDocumentState,
  result: SaveFileOutcome,
): Partial<EditorTab> {
  const dirty = liveDocument.content !== snapshot.content
    || liveDocument.lineEndings !== snapshot.lineEndings
    || current.bom !== snapshot.bom
    || current.encoding !== snapshot.encoding;

  return {
    // The tab-level content may be an older fallback while CodeMirror owns
    // the live buffer. A save response is a safe point to refresh it from the
    // captured live snapshot, including edits newer than the saved revision.
    content: dirty ? liveDocument.content : snapshot.content,
    lineEndings: liveDocument.lineEndings,
    savedContent: snapshot.content,
    savedLineEndings: snapshot.lineEndings,
    savedBom: snapshot.bom,
    savedRevision: snapshot.revision,
    normalizedContentVersion: dirty ? undefined : current.contentVersion,
    normalizedSavedRevision: snapshot.revision,
    dirty,
    diskModifiedAt: result.modifiedAt,
    diskSize: result.size,
    diskFingerprint: result.fingerprint,
    diskIdentity: result.identity ?? undefined,
  };
}
