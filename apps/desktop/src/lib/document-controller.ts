import type { EditorDocumentHandle, EditorDocumentSeed } from "../components/EditorPane";
import {
  EDITOR_CACHE_MAX_BYTES,
  estimateEditorDocumentCacheBytes,
  leastRecentlyUsedReleasableDocument,
  type EditorDocumentCacheStatus,
} from "./editor-cache-budget";
import type { EditorTab } from "../types";

export type DocumentRevision = { read: () => number; bump: () => void };

export type DocumentControllerHooks = {
  createRevision: () => DocumentRevision;
  /** Optional estimate for owner-held tab text/maps not stored by handles. */
  getAdditionalCacheBytes?: () => number;
};

export type ConfirmCacheEviction = (tabId: string, currentSeed: EditorDocumentSeed) => boolean;
export type DocumentControllerCacheStatus = EditorDocumentCacheStatus<EditorDocumentSeed>;

/**
 * Owns the live editor document registry: one handle per tab id, plus one
 * content-revision counter per tab used to invalidate memoized reads of the
 * editor text. Registering a document eagerly creates its revision counter;
 * releasing a tab removes both the handle and the counter, while unregister
 * only detaches the handle (the editor unmounted, the tab may still exist).
 * The cache estimate combines handle-owned data with the optional owner-held
 * fallback estimate. It is a soft source-data budget, not a whole-app heap or
 * RSS limit; transient save snapshots are outside this cache accounting.
 * Reactivity is injected through createRevision so this stays runtime-neutral.
 */
export function createDocumentController(hooks: DocumentControllerHooks) {
  const handles = new Map<string, EditorDocumentHandle>();
  const retainedHandles = new Map<string, EditorDocumentHandle>();
  const revisions = new Map<string, DocumentRevision>();

  const getRevision = (tabId: string) => {
    let revision = revisions.get(tabId);
    if (!revision) {
      revision = hooks.createRevision();
      revisions.set(tabId, revision);
    }
    return revision;
  };

  const register = (tabId: string, handle: EditorDocumentHandle) => {
    handles.set(tabId, handle);
    retainedHandles.delete(tabId);
    getRevision(tabId);
  };

  const unregister = (tabId: string, retainedHandle?: EditorDocumentHandle) => {
    handles.delete(tabId);
    if (retainedHandle) retainedHandles.set(tabId, retainedHandle);
    else retainedHandles.delete(tabId);
  };

  const release = (tabId: string) => {
    handles.delete(tabId);
    retainedHandles.delete(tabId);
    revisions.delete(tabId);
  };

  const getActiveHandle = (tabId: string) => handles.get(tabId);
  const getHandle = (tabId: string) => handles.get(tabId) ?? retainedHandles.get(tabId);
  const getCachedDocument = (tabId: string): EditorDocumentSeed | undefined => retainedHandles.get(tabId)?.getDetachedDocument();
  const getCacheBytes = () => {
    const documentBytes = estimateEditorDocumentCacheBytes([
      ...handles.values(),
      ...retainedHandles.values(),
    ].map((handle) => handle.getCacheFootprint()));
    const additionalBytes = hooks.getAdditionalCacheBytes?.() ?? 0;
    return documentBytes + (Number.isFinite(additionalBytes) ? Math.max(0, additionalBytes) : 0);
  };

  /**
   * Enforce the soft global byte budget over documents that are no longer
   * attached to an editor. Dirty documents and any document with Undo/Redo
   * history remain protected; a remaining overage is reported to the caller.
   * This is intended for idle/activation scheduling, not the keystroke path.
   */
  const enforceCacheBudget = (
    maxBytes = EDITOR_CACHE_MAX_BYTES,
    confirmEviction?: ConfirmCacheEviction,
  ): DocumentControllerCacheStatus => {
    let estimatedBytes = getCacheBytes();
    const evictedTabIds: string[] = [];
    const evictedDocuments: Array<{ tabId: string; document: EditorDocumentSeed }> = [];

    if (estimatedBytes > maxBytes && confirmEviction) {
      const attempted = new Set<string>();
      while (estimatedBytes > maxBytes) {
        const candidate = leastRecentlyUsedReleasableDocument(
          [...retainedHandles.entries()]
            .filter(([id]) => !attempted.has(id))
            .map(([id, handle]) => ({ id, state: handle.getCacheEvictionState() })),
        );
        if (!candidate) break;
        attempted.add(candidate.id);
        const handle = retainedHandles.get(candidate.id);
        if (!handle) continue;
        const currentState = handle.getCacheEvictionState();
        if (!currentState.canRelease || currentState.dirty || currentState.hasUndoHistory) continue;
        const currentSeed = handle.getDetachedDocument();
        if (!currentSeed || !confirmEviction(candidate.id, currentSeed)) continue;
        // The owner callback can update reactive state. Confirm identity and
        // eligibility again before dropping the retained source of truth.
        if (retainedHandles.get(candidate.id) !== handle) continue;
        const finalState = handle.getCacheEvictionState();
        if (!finalState.canRelease || finalState.dirty || finalState.hasUndoHistory) continue;
        retainedHandles.delete(candidate.id);
        evictedTabIds.push(candidate.id);
        evictedDocuments.push({ tabId: candidate.id, document: currentSeed });
        // Recount after every release because documents may share Text and
        // persistent marker nodes, so subtracting a per-document estimate
        // could otherwise overstate the amount actually reclaimed.
        estimatedBytes = getCacheBytes();
      }
    }

    return {
      estimatedBytes,
      maxBytes,
      overBudget: estimatedBytes > maxBytes,
      evictedTabIds,
      evictedDocuments,
    };
  };

  const getText = (tab?: EditorTab) => tab ? getHandle(tab.id)?.getText() ?? tab.content : "";

  const dispose = () => {
    handles.clear();
    retainedHandles.clear();
    revisions.clear();
  };

  return { register, unregister, release, getRevision, getHandle, getActiveHandle, getCachedDocument, getCacheBytes, enforceCacheBudget, getText, dispose };
}

export type DocumentController = ReturnType<typeof createDocumentController>;
