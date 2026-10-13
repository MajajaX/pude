import type { EditorTab, ReadFileResult } from "../types";

export type ExternalConflictState = {
  queued: () => EditorTab[];
  setQueued: (updater: (items: EditorTab[]) => EditorTab[]) => void;
};

export type ExternalConflictHooks = {
  readFile: (path: string) => Promise<ReadFileResult>;
  normalizeReadFile: (file: ReadFileResult) => ReadFileResult;
  getWorkspaceGeneration: () => number;
  getTab: (id: string) => EditorTab | undefined;
  samePath: (left: string, right: string) => boolean;
  updateTab: (id: string, changes: Partial<EditorTab>) => void;
  bumpDocumentContentRevision: (tabId: string) => void;
  getDocumentText: (tab: EditorTab) => string;
  buildTextDiff: (before: string, after: string) => string;
  openDiskDiff: (path: string, diffText: string) => void;
  notify: (message: string) => void;
  errorMessage: (error: unknown, fallback: string) => string;
};

/**
 * Owns the external-change conflict queue and the reload/compare
 * coordination for queued conflicts. The queue is upserted by tab id and
 * consumed front-first; reload adopts the on-disk version when the tab is
 * still at the captured revision, and compare opens an editor-vs-disk diff
 * under the same staleness guards. All tab/bookkeeping and UI side effects
 * stay with the caller through the hooks; this module only coordinates
 * queue order and the guard checks around the injected readFile bridge call.
 */
export function createExternalConflictController(state: ExternalConflictState, hooks: ExternalConflictHooks) {
  const queue = (tab: EditorTab) => state.setQueued((items) => {
    const index = items.findIndex((item) => item.id === tab.id);
    if (index < 0) return [...items, tab];
    const next = [...items];
    next[index] = tab;
    return next;
  });

  const dismiss = (tabId: string) => state.setQueued((items) => items.filter((item) => item.id !== tabId));

  const reset = () => state.setQueued(() => []);

  const first = () => {
    const queued = state.queued()[0];
    return queued ? hooks.getTab(queued.id) ?? queued : undefined;
  };

  const reload = async () => {
    const conflict = first();
    if (!conflict) return;
    const generation = hooks.getWorkspaceGeneration();
    const revision = conflict.revision;
    try {
      const file = await hooks.readFile(conflict.path).then(hooks.normalizeReadFile);
      const current = hooks.getTab(conflict.id);
      if (generation !== hooks.getWorkspaceGeneration() || !current || !hooks.samePath(current.path, conflict.path) || current.revision !== revision) return;
      const nextRevision = current.revision + 1;
      hooks.updateTab(conflict.id, { content: file.content, savedContent: file.content, dirty: false, orphaned: false, lineEnding: file.lineEnding, lineEndings: file.lineEndings, savedLineEndings: file.lineEndings, bom: file.bom, savedBom: file.bom, encoding: file.encoding === "utf-8-bom" ? "UTF-8 BOM" : "UTF-8", revision: nextRevision, savedRevision: nextRevision, contentVersion: current.contentVersion + 1, diskModifiedAt: file.modifiedAt, diskSize: file.size, diskFingerprint: file.fingerprint, largeFile: file.size > 5 * 1024 * 1024 });
      hooks.bumpDocumentContentRevision(conflict.id);
      dismiss(conflict.id);
      hooks.notify(`Reloaded ${conflict.name}`);
    } catch (error) {
      hooks.notify(hooks.errorMessage(error, "Unable to reload changed file."));
    }
  };

  const compare = async (tab: EditorTab) => {
    const generation = hooks.getWorkspaceGeneration();
    try {
      const file = await hooks.readFile(tab.path).then(hooks.normalizeReadFile);
      const current = hooks.getTab(tab.id);
      if (generation !== hooks.getWorkspaceGeneration() || !current || !hooks.samePath(current.path, tab.path) || current.revision !== tab.revision) return;
      hooks.openDiskDiff(tab.path, hooks.buildTextDiff(hooks.getDocumentText(current), file.content));
      dismiss(tab.id);
    } catch (error) {
      hooks.notify(hooks.errorMessage(error, "Unable to compare the changed file."));
    }
  };

  const dispose = () => {
    reset();
  };

  return { queue, dismiss, reset, first, reload, compare, dispose };
}

export type ExternalConflictController = ReturnType<typeof createExternalConflictController>;
