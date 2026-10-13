import type { EditorTab } from "../types";
import { resolveQueuedSaveExpectation, type SaveQueueResult } from "./save-queue";

export type SaveSnapshot = {
  tabId: string;
  path: string;
  content: string;
  lineEnding: EditorTab["lineEnding"];
  lineEndings: string;
  bom: boolean;
  encoding: EditorTab["encoding"];
  revision: number;
  expectedModifiedAt?: number;
  expectedSize?: number;
  expectedFingerprint?: string;
};

export type SaveFileOutcome = {
  modifiedAt?: number;
  size?: number;
  fingerprint?: string;
  identity?: string | null;
};

export type SaveControllerHooks = {
  saveFile: (
    path: string,
    content: string,
    lineEnding: SaveSnapshot["lineEnding"],
    lineEndings: string,
    bom: boolean,
    expectedModifiedAt?: number,
    expectedSize?: number,
    expectedFingerprint?: string,
  ) => Promise<SaveFileOutcome>;
  onSaved?: (snapshot: SaveSnapshot, result: SaveFileOutcome) => void;
  onSaveFailed?: (snapshot: SaveSnapshot, error: unknown) => void;
};

/**
 * Owns the per-tab save queue: queued saves for one tab run strictly in
 * order, each save guards against the disk state produced by the preceding
 * successful save on the same path, and the in-flight snapshot stays visible
 * to disk verification until the bridge call settles. The caller keeps all
 * tab/bookkeeping side effects via the hooks; this module only coordinates
 * queueing, expectations, and pending snapshot lifetime.
 */
export function createSaveController(hooks: SaveControllerHooks) {
  const saveQueues = new Map<string, Promise<SaveQueueResult>>();
  const pendingSaveSnapshots = new Map<string, SaveSnapshot>();
  const diskReads = new Set<{ tabId: string; stale: boolean }>();

  const enqueue = (snapshot: SaveSnapshot): Promise<SaveQueueResult> => {
    for (const read of diskReads) if (read.tabId === snapshot.tabId) read.stale = true;
    const previous = saveQueues.get(snapshot.tabId);
    const previousResult = previous
      ? previous.catch(() => ({ ok: false, path: snapshot.path } satisfies SaveQueueResult))
      : Promise.resolve<SaveQueueResult | undefined>(undefined);
    const queued = previousResult.then(async (completed) => {
      pendingSaveSnapshots.set(snapshot.tabId, snapshot);
      const expected = resolveQueuedSaveExpectation({
        path: snapshot.path,
        modifiedAt: snapshot.expectedModifiedAt,
        size: snapshot.expectedSize,
        fingerprint: snapshot.expectedFingerprint,
      }, completed);
      try {
        const result = await hooks.saveFile(snapshot.path, snapshot.content, snapshot.lineEnding, snapshot.lineEndings, snapshot.bom, expected.modifiedAt, expected.size, expected.fingerprint);
        hooks.onSaved?.(snapshot, result);
        return { ok: true, path: snapshot.path, ...result } satisfies SaveQueueResult;
      } catch (error) {
        hooks.onSaveFailed?.(snapshot, error);
        return { ok: false, path: snapshot.path } satisfies SaveQueueResult;
      } finally {
        if (pendingSaveSnapshots.get(snapshot.tabId)?.revision === snapshot.revision) pendingSaveSnapshots.delete(snapshot.tabId);
      }
    });
    saveQueues.set(snapshot.tabId, queued);
    void queued.finally(() => {
      if (saveQueues.get(snapshot.tabId) === queued) saveQueues.delete(snapshot.tabId);
    });
    return queued;
  };

  const getPendingSnapshot = (tabId: string) => pendingSaveSnapshots.get(tabId);

  const readAfterSaves = async <T>(tabId: string, read: () => Promise<T>): Promise<T> => {
    for (;;) {
      const queued = saveQueues.get(tabId);
      if (queued) {
        await queued;
        continue;
      }
      const pendingRead = { tabId, stale: false };
      diskReads.add(pendingRead);
      const outcome = await Promise.resolve().then(read).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ).finally(() => diskReads.delete(pendingRead));
      if (pendingRead.stale || saveQueues.has(tabId)) continue;
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    }
  };

  const dispose = () => {
    saveQueues.clear();
    pendingSaveSnapshots.clear();
    diskReads.clear();
  };

  return { enqueue, getPendingSnapshot, readAfterSaves, dispose };
}

export type SaveController = ReturnType<typeof createSaveController>;
