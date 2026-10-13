import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  attachSessionWindow,
  claimRecoverableSessionCandidate,
  closeSessionWindow,
  commitSessionCheckpoint,
  createSessionMetadata,
  discardSessionCheckpoint,
  getRecoveryStorageUsage,
  loadSessionCheckpointResult,
  listRecoverableSessionCheckpointCandidates,
  loadSessionCheckpoint,
  parseRecovery,
  parseRecoveryBaseline,
  readLatestSessionCheckpoint,
  readLatestSessionCheckpointMetadataResult,
  readRecoveryStorage,
  readRecoveryBaselineResult,
  readRecoveryStorageResult,
  recoveryBaselineKey,
  recoveryBaselineSizeBytes,
  recoverySnapshotSizeBytes,
  recoveryStorageKey,
  sessionCheckpointStorageKey,
  removeRecoveryStorage,
  setRecoveryDatabaseBlockedHandler,
  type SessionMetadata,
  writeRecoveryStorage,
} from "./session-storage";
import {
  invalidateRecoveryDatabase,
  openRecoveryDatabase,
  readSessionCheckpointDatabase,
  RECOVERY_DATABASE_OPEN_TIMEOUT_MS,
  RECOVERY_METADATA_STORE,
  RECOVERY_STORE,
  writeSessionCheckpointDatabase,
} from "./session-storage-idb";
import type { DirectoryEntry, EditorTab } from "../types";
import { MAX_FALLBACK_CHECKPOINT_BYTES } from "./session-storage-fallback";

const fakeIndexedDb = globalThis.indexedDB;

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const storage = new MemoryStorage();
let lockTails = new Map<string, Promise<void>>();

async function clearRecoveryDatabase(): Promise<void> {
  invalidateRecoveryDatabase();
  if (!fakeIndexedDb) return;
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDb });
  await new Promise<void>((resolve) => {
    const request = fakeIndexedDb.deleteDatabase("pude-recovery-v1");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

function installBrowserStorage(): void {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async <T>(_name: string, _options: { mode: "exclusive" }, callback: () => T | Promise<T>) => {
      const name = _name;
      const previous = lockTails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      lockTails.set(name, current);
      await previous;
      try { return await callback(); }
      finally {
        release();
        if (lockTails.get(name) === current) lockTails.delete(name);
      }
    } } },
  });
}

function tab(id: string, workspace: string, revision: number, savedRevision = 1, dirty = true): EditorTab {
  const path = `${workspace}/src/${id}.ts`;
  return {
    id,
    path,
    name: `${id}.ts`,
    content: `const ${id} = ${revision};`,
    savedContent: "const saved = 1;",
    dirty,
    lineEnding: "lf",
    lineEndings: "c",
    savedLineEndings: "c",
    bom: false,
    savedBom: false,
    encoding: "UTF-8",
    language: "TypeScript",
    cursorLine: 1,
    cursorColumn: 1,
    revision,
    savedRevision: dirty ? savedRevision : revision,
    contentVersion: 0,
  };
}

function workspaceRoot(workspace: string): DirectoryEntry {
  return { name: workspace.split("/").at(-1) ?? "workspace", path: workspace, kind: "directory", expanded: true, loaded: true, children: [] };
}

function session(workspace: string, tabs: EditorTab[], activeTabId = tabs[0]?.id): SessionMetadata {
  return createSessionMetadata(workspace, activeTabId, tabs, workspaceRoot(workspace));
}

function v1Recovery(candidate: EditorTab) {
  return parseRecovery({
    version: 1,
    tabId: candidate.id,
    path: candidate.path,
    revision: candidate.revision,
    content: candidate.content,
    savedContent: candidate.savedContent,
    lineEnding: candidate.lineEnding,
  })!;
}

function v2Recovery(candidate: EditorTab) {
  return parseRecovery({
    version: 2,
    tabId: candidate.id,
    path: candidate.path,
    revision: candidate.revision,
    savedRevision: candidate.savedRevision,
    content: candidate.content,
    savedContent: "",
    savedContentUnavailable: true,
    lineEnding: candidate.lineEnding,
    lineEndings: candidate.lineEndings,
    savedLineEndings: candidate.savedLineEndings,
    bom: candidate.bom,
    savedBom: candidate.savedBom,
    encoding: candidate.encoding,
  })!;
}

function baseline(candidate: EditorTab) {
  return parseRecoveryBaseline({
    version: 1,
    tabId: candidate.id,
    path: candidate.path,
    savedRevision: candidate.savedRevision,
    savedContent: "const saved = 1;",
    savedLineEndings: candidate.savedLineEndings,
    savedBom: candidate.savedBom,
    encoding: candidate.encoding,
  })!;
}

type Operation = { kind: "get" | "put" | "delete" | "cursor"; store: string; key?: IDBValidKey; value?: unknown };

function traceIdbOperations(): { operations: Operation[]; stop: () => void } {
  const operations: Operation[] = [];
  const get = IDBObjectStore.prototype.get;
  const put = IDBObjectStore.prototype.put;
  const remove = IDBObjectStore.prototype.delete;
  const cursor = IDBObjectStore.prototype.openCursor;
  const indexCursor = IDBIndex.prototype.openCursor;
  const spies = [
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key?: IDBValidKey | IDBKeyRange) {
      operations.push({ kind: "get", store: this.name, key: key as IDBValidKey | undefined });
      return get.call(this, key as IDBValidKey | IDBKeyRange);
    }),
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      operations.push({ kind: "put", store: this.name, key, value });
      return put.call(this, value, key);
    }),
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      operations.push({ kind: "delete", store: this.name, key: key as IDBValidKey });
      return remove.call(this, key);
    }),
    vi.spyOn(IDBObjectStore.prototype, "openCursor").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["openCursor"]>) {
      operations.push({ kind: "cursor", store: this.name });
      return cursor.apply(this, args);
    }),
    vi.spyOn(IDBIndex.prototype, "openCursor").mockImplementation(function (this: IDBIndex, ...args: Parameters<IDBIndex["openCursor"]>) {
      operations.push({ kind: "cursor", store: this.objectStore.name, key: this.name });
      return indexCursor.apply(this, args);
    }),
  ];
  return { operations, stop: () => spies.forEach((spy) => spy.mockRestore()) };
}

beforeEach(async () => {
  vi.useRealTimers();
  lockTails = new Map();
  storage.clear();
  installBrowserStorage();
  if (fakeIndexedDb) await clearRecoveryDatabase();
});

afterEach(() => {
  invalidateRecoveryDatabase();
  setRecoveryDatabaseBlockedHandler(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("recovery checkpoint differential persistence", () => {
  it("writes only changed snapshots, preserves unchanged baselines, and deletes only the cleaned tab", async () => {
    const workspace = "/workspace-diff";
    const scope = "diff-scope";
    const first = tab("first", workspace, 2);
    const second = tab("second", workspace, 2);
    const firstKey = recoveryStorageKey(first.id, scope);
    const secondKey = recoveryStorageKey(second.id, scope);
    const firstBaselineKey = recoveryBaselineKey(first.id, scope);
    const secondBaselineKey = recoveryBaselineKey(second.id, scope);
    const seeded = await commitSessionCheckpoint({
      scope,
      session: session(workspace, [first, second]),
      recoveries: [v2Recovery(first), v2Recovery(second)],
      baselines: [baseline(first), baseline(second)],
      now: 100,
    });
    expect(seeded).toMatchObject({ ok: true, complete: true, updatedRecoveryKeys: [firstKey, secondKey] });
    const initialUsage = await getRecoveryStorageUsage();

    const metadataTrace = traceIdbOperations();
    const reordered = await commitSessionCheckpoint({
      scope,
      session: session(workspace, [second, first], second.id),
      now: 200,
    });
    metadataTrace.stop();
    expect(reordered).toMatchObject({ ok: true, complete: true, updatedRecoveryKeys: [], removedRecoveryKeys: [] });
    expect(metadataTrace.operations.filter((item) => item.kind === "get" && item.store === RECOVERY_STORE)).toHaveLength(0);
    expect(metadataTrace.operations.filter((item) => item.kind === "put" && item.store === RECOVERY_STORE)).toHaveLength(0);
    expect(metadataTrace.operations.filter((item) => item.kind === "put" && item.store === RECOVERY_METADATA_STORE && item.key !== "__pude_recovery_total_v1__")).toHaveLength(0);
    expect(metadataTrace.operations.filter((item) => item.kind === "put" && item.store === "checkpoints")).toHaveLength(1);
    expect(await getRecoveryStorageUsage()).toMatchObject({ indexedDbBytes: initialUsage.indexedDbBytes });

    const changedFirst = { ...first, revision: 2, content: "const first = 2;" };
    const changedTrace = traceIdbOperations();
    const changed = await commitSessionCheckpoint({
      scope,
      session: session(workspace, [second, changedFirst], second.id),
      recoveries: [v2Recovery(changedFirst)],
      now: 300,
    });
    changedTrace.stop();
    expect(changed).toMatchObject({ ok: true, complete: true, updatedRecoveryKeys: [firstKey], removedRecoveryKeys: [] });
    expect(changedTrace.operations.filter((item) => item.kind === "get" && item.store === RECOVERY_STORE)).toHaveLength(0);
    expect(changedTrace.operations.filter((item) => item.kind === "put" && item.store === RECOVERY_STORE).map((item) => item.key)).toEqual([firstKey]);
    expect(changedTrace.operations.filter((item) => item.kind === "put" && item.store === RECOVERY_STORE).map((item) => (item.value as { bytes: number }).bytes)).toEqual([recoverySnapshotSizeBytes(v2Recovery(changedFirst))]);
    expect(changedTrace.operations.filter((item) => item.kind === "put" && item.store === RECOVERY_STORE && item.key === firstBaselineKey)).toHaveLength(0);
    expect(changedTrace.operations.filter((item) => item.kind === "put" && item.store === RECOVERY_STORE && item.key === secondBaselineKey)).toHaveLength(0);
    expect((await readLatestSessionCheckpoint(scope)?.then((value) => value?.recoveries[secondKey]?.content))).toBe(second.content);

    const cleanFirst = { ...changedFirst, dirty: false, revision: 3, savedRevision: 3 };
    const deleteTrace = traceIdbOperations();
    const cleaned = await commitSessionCheckpoint({
      scope,
      session: session(workspace, [second, cleanFirst], second.id),
      recoveryKeysToRemove: [firstKey],
      now: 400,
    });
    deleteTrace.stop();
    expect(cleaned).toMatchObject({ ok: true, complete: true, updatedRecoveryKeys: [], removedRecoveryKeys: [firstKey], durability: "indexeddb" });
    expect(deleteTrace.operations.filter((item) => item.kind === "delete" && item.store === RECOVERY_STORE).map((item) => item.key).sort()).toEqual([firstBaselineKey, firstKey].sort());
    expect(deleteTrace.operations.filter((item) => item.kind === "get" && item.store === RECOVERY_STORE)).toHaveLength(0);
    const restored = await readLatestSessionCheckpoint(scope);
    expect(restored?.recoveries[secondKey]?.content).toBe(second.content);
    expect(restored?.recoveries[firstKey]).toBeUndefined();
    const finalUsage = await getRecoveryStorageUsage();
    expect(finalUsage.indexedDbBytes).toBe(initialUsage.indexedDbBytes - recoverySnapshotSizeBytes(v2Recovery(changedFirst)) - recoveryBaselineSizeBytes(baseline(first)));
  });

  it("rejects an oversized localStorage checkpoint before serializing recovery text and retains the prior version", async () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    invalidateRecoveryDatabase();
    const workspace = "/workspace-fallback-bound";
    const scope = "fallback-bound";
    const existing = tab("large", workspace, 2);
    await commitSessionCheckpoint({ scope, session: session(workspace, [existing]), recoveries: [v1Recovery(existing)], now: 100 });
    const oversized = { ...existing, revision: 3, content: "x".repeat(Math.floor(MAX_FALLBACK_CHECKPOINT_BYTES / 2) + 1) };
    const stringify = vi.spyOn(JSON, "stringify");
    const rejected = await commitSessionCheckpoint({ scope, session: session(workspace, [oversized]), recoveries: [v1Recovery(oversized)], now: 200 });
    expect(rejected).toMatchObject({ ok: false, complete: false, reason: "quota", durability: "none" });
    expect(stringify.mock.calls.some(([value]) => Boolean(value && typeof value === "object" && "recoveries" in value))).toBe(false);
    expect((await readLatestSessionCheckpoint(scope))?.sequence).toBe(1);
    expect((await readLatestSessionCheckpoint(scope))?.recoveries[recoveryStorageKey(existing.id, scope)]?.content).toBe(existing.content);
  });

  it("keeps aggregate usage accurate when removing a snapshot or discarding one scope", async () => {
    const workspace = "/workspace-usage";
    const removed = tab("removed", workspace, 2);
    const retained = tab("retained", workspace, 2);
    const removedKey = recoveryStorageKey(removed.id, "manual-removal");
    const retainedKey = recoveryStorageKey(retained.id, "other-scope");
    await writeRecoveryStorage(removedKey, v1Recovery(removed));
    await writeRecoveryStorage(retainedKey, v1Recovery(retained));
    expect((await getRecoveryStorageUsage()).indexedDbBytes).toBe(recoverySnapshotSizeBytes(v1Recovery(removed)) + recoverySnapshotSizeBytes(v1Recovery(retained)));
    await removeRecoveryStorage(removedKey);
    expect((await getRecoveryStorageUsage()).indexedDbBytes).toBe(recoverySnapshotSizeBytes(v1Recovery(retained)));
    expect(await readRecoveryStorage(removedKey)).toBeNull();
    expect(await readRecoveryStorage(retainedKey)).not.toBeNull();

    const scoped = tab("scoped", workspace, 2);
    const scopedKey = recoveryStorageKey(scoped.id, "discard-me");
    await commitSessionCheckpoint({
      scope: "discard-me",
      session: session(workspace, [scoped]),
      recoveries: [v1Recovery(scoped)],
      now: 100,
    });
    const discarded = await discardSessionCheckpoint("discard-me");
    expect(discarded.ok).toBe(true);
    expect(discarded.removedKeys).toContain(scopedKey);
    expect((await getRecoveryStorageUsage()).indexedDbBytes).toBe(recoverySnapshotSizeBytes(v1Recovery(retained)));
    expect(await readRecoveryStorage(retainedKey)).not.toBeNull();
  });
});

describe("recovery read availability", () => {
  it("keeps an unread IDB snapshot unavailable despite a stale fallback and retries the exact original body", async () => {
    const candidate = tab("faulted", "/workspace-read-fault", 9);
    const key = recoveryStorageKey(candidate.id, "read-fault");
    const original = parseRecovery({
      ...v1Recovery(candidate),
      content: "exact edited\r\nbody\r\nwith BOM",
      savedContent: "exact saved\r\nbody",
      lineEnding: "crlf",
      lineEndings: "ccc",
      savedLineEndings: "cc",
      bom: true,
      savedBom: true,
      encoding: "UTF-8 BOM",
    })!;
    const staleFallback = { ...original, revision: 2, content: "older fallback" };
    await writeRecoveryStorage(key, original);
    storage.setItem(key, JSON.stringify(staleFallback));

    const databaseTransaction = IDBDatabase.prototype.transaction;
    const transactionSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
      this: IDBDatabase,
      storeNames: string | Iterable<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      if (typeof storeNames === "string" && storeNames === RECOVERY_STORE && mode === "readonly") throw new Error("injected transient IDB read fault");
      return databaseTransaction.call(this, storeNames, mode, options);
    });

    const unavailable = await readRecoveryStorageResult(key);
    expect(unavailable.status).toBe("unavailable");
    if (unavailable.status === "unavailable") expect(parseRecovery(unavailable.observedValue)).toMatchObject({ revision: 2, content: "older fallback" });

    transactionSpy.mockRestore();
    const retried = await readRecoveryStorageResult(key);
    expect(retried.status).toBe("available");
    if (retried.status === "available") expect(parseRecovery(retried.value)).toEqual(original);
  });

  it("distinguishes a missing baseline from a failed baseline transaction and retries it", async () => {
    const candidate = tab("baseline-fault", "/workspace-baseline-fault", 7);
    const scope = "baseline-read-fault";
    const key = recoveryBaselineKey(candidate.id, scope);
    const expected = baseline(candidate);
    await commitSessionCheckpoint({
      scope,
      session: session(candidate.path.slice(0, candidate.path.lastIndexOf("/src")), [candidate]),
      recoveries: [v2Recovery(candidate)],
      baselines: [expected],
      now: 100,
    });

    const databaseTransaction = IDBDatabase.prototype.transaction;
    const transactionSpy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
      this: IDBDatabase,
      storeNames: string | Iterable<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      if (typeof storeNames === "string" && storeNames === RECOVERY_STORE && mode === "readonly") throw new Error("injected baseline read fault");
      return databaseTransaction.call(this, storeNames, mode, options);
    });
    const unavailable = await readRecoveryBaselineResult(key);
    expect(unavailable.status).toBe("unavailable");
    transactionSpy.mockRestore();

    const retried = await readRecoveryBaselineResult(key);
    expect(retried).toEqual({ status: "available", value: expected });
    expect(await readRecoveryBaselineResult(recoveryBaselineKey("confirmed-missing", scope))).toEqual({ status: "missing" });
  });

  it("does not trust a matching fallback when checkpoint metadata or body reads fail", async () => {
    const workspace = "/workspace-checkpoint-read-fault";
    const scope = "checkpoint-read-fault";
    const candidate = tab("checkpoint-read", workspace, 8);
    const seeded = await commitSessionCheckpoint({ scope, session: session(workspace, [candidate]), recoveries: [v1Recovery(candidate)], now: 100 });
    expect(seeded.ok).toBe(true);

    const databaseTransaction = IDBDatabase.prototype.transaction;
    const metadataFault = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
      this: IDBDatabase,
      storeNames: string | Iterable<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      const stores = typeof storeNames === "string" ? [storeNames] : [...storeNames];
      if (stores.includes("checkpoints") && stores.includes(RECOVERY_METADATA_STORE) && mode === "readonly") {
        throw new Error("injected metadata transaction fault");
      }
      return databaseTransaction.call(this, storeNames, mode, options);
    });
    const metadataUnavailable = await readLatestSessionCheckpointMetadataResult(scope);
    expect(metadataUnavailable.status).toBe("unavailable");
    metadataFault.mockRestore();

    const metadata = await readLatestSessionCheckpointMetadataResult(scope);
    expect(metadata.status).toBe("available");
    if (metadata.status !== "available") throw new Error("expected metadata to be available");

    const bodyFault = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
      this: IDBDatabase,
      storeNames: string | Iterable<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      const stores = typeof storeNames === "string" ? [storeNames] : [...storeNames];
      if (stores.includes("checkpoints") && stores.includes(RECOVERY_STORE) && mode === "readonly") {
        throw new Error("injected checkpoint body transaction fault");
      }
      return databaseTransaction.call(this, storeNames, mode, options);
    });
    const bodyUnavailable = await loadSessionCheckpointResult(scope, { expected: metadata.value.checkpoint });
    expect(bodyUnavailable.status).toBe("unavailable");
    bodyFault.mockRestore();

    const loaded = await loadSessionCheckpointResult(scope, { expected: metadata.value.checkpoint });
    expect(loaded.status).toBe("available");
    if (loaded.status === "available") expect(loaded.value.recoveries[recoveryStorageKey(candidate.id, scope)]?.content).toBe(candidate.content);
  });

  it("rejects an old matching fallback when a successful DB body read shows a newer checkpoint", async () => {
    const workspace = "/workspace-newer-db-race";
    const scope = "newer-db-race";
    const candidate = tab("race", workspace, 8);
    await commitSessionCheckpoint({ scope, session: session(workspace, [candidate]), recoveries: [v1Recovery(candidate)], now: 100 });
    const oldCheckpoint = await readLatestSessionCheckpoint(scope);
    expect(oldCheckpoint).not.toBeNull();
    if (!oldCheckpoint) throw new Error("expected seeded checkpoint");
    storage.setItem(sessionCheckpointStorageKey(scope), JSON.stringify(oldCheckpoint));
    const metadata = await readLatestSessionCheckpointMetadataResult(scope);
    expect(metadata.status).toBe("available");
    if (metadata.status !== "available") throw new Error("expected selected metadata");

    const readBody = readSessionCheckpointDatabase;
    const bodySpy = vi.spyOn(await import("./session-storage-idb"), "readSessionCheckpointDatabase").mockImplementation(async (database, selectedScope) => {
      const result = await readBody(database, selectedScope);
      if (!result) return result;
      return {
        ...result,
        checkpoint: { ...result.checkpoint, checkpointId: "unseen-newer-checkpoint", sequence: result.checkpoint.sequence + 1, committedAt: result.checkpoint.committedAt + 1 },
      };
    });

    const loaded = await loadSessionCheckpointResult(scope, { expected: metadata.value.checkpoint });
    expect(loaded.status).toBe("unavailable");
    bodySpy.mockRestore();
  });

  it("retains the prior fallback body when a new fallback commit cannot verify old DB recovery bodies", async () => {
    const workspace = "/workspace-fallback-retain";
    const scope = "fallback-retain";
    const original = tab("retained", workspace, 4);
    await commitSessionCheckpoint({ scope, session: session(workspace, [original]), recoveries: [v1Recovery(original)], now: 100 });
    const previousFull = await readLatestSessionCheckpoint(scope);
    if (!previousFull) throw new Error("expected seeded checkpoint");
    const checkpointKey = sessionCheckpointStorageKey(scope);
    storage.setItem(checkpointKey, JSON.stringify(previousFull));
    const originalFallbackBody = storage.getItem(checkpointKey);

    const idbModule = await import("./session-storage-idb");
    const writeSpy = vi.spyOn(idbModule, "writeSessionCheckpointDatabase").mockResolvedValue({ saved: false, skipped: true, evictedKeys: [] });
    const readSpy = vi.spyOn(idbModule, "readSessionCheckpointDatabase").mockRejectedValue(new Error("temporary checkpoint body read fault"));
    const changed = { ...original, revision: 5, content: "new edit" };
    const result = await commitSessionCheckpoint({ scope, session: session(workspace, [changed]), recoveries: [v1Recovery(changed)], now: 200 });
    expect(result).toMatchObject({ ok: false, reason: "unavailable", durability: "none" });
    expect(storage.getItem(checkpointKey)).toBe(originalFallbackBody);
    expect(writeSpy).toHaveBeenCalledOnce();
    expect(readSpy).toHaveBeenCalledOnce();
    writeSpy.mockRestore();
    readSpy.mockRestore();
  });
});

describe("recovery candidate metadata and selected loading", () => {
  it("lists and claims one of ten workspaces without reading any snapshot body", async () => {
    for (let index = 0; index < 10; index += 1) {
      const workspace = `/workspace-${index}`;
      const tabValue = tab(`tab-${index}`, workspace, 2);
      const scope = `scope-${index}`;
      await commitSessionCheckpoint({ scope, session: session(workspace, [tabValue]), recoveries: [v1Recovery(tabValue)], now: 100 + index });
      if (index === 0) {
        const attached = await attachSessionWindow({ windowId: "old-window", scope, workspace, dirtyRecoveryKeys: [recoveryStorageKey(tabValue.id, scope)], now: 200 });
        await closeSessionWindow(attached.lease!, { now: 201 });
      }
    }

    const listTrace = traceIdbOperations();
    const listed = await listRecoverableSessionCheckpointCandidates("/workspace-0");
    listTrace.stop();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ workspace: "/workspace-0", completeMetadata: true, closedWindowIds: ["old-window"] });
    expect(listTrace.operations.some((item) => item.store === RECOVERY_STORE)).toBe(false);
    expect(listTrace.operations.filter((item) => item.kind === "get" && item.store === RECOVERY_METADATA_STORE).map((item) => item.key)).toEqual([recoveryStorageKey("tab-0", "scope-0")]);
    expect(listTrace.operations.filter((item) => item.kind === "cursor" && item.store === "checkpoints")).toEqual([{ kind: "cursor", store: "checkpoints", key: "workspace" }]);

    const claimTrace = traceIdbOperations();
    const claimed = await claimRecoverableSessionCandidate({
      windowId: "new-window",
      workspace: "/workspace-0",
      candidate: { scope: listed[0].checkpoint.scope, checkpointId: listed[0].checkpoint.checkpointId, sequence: listed[0].checkpoint.sequence },
      now: 300,
    });
    claimTrace.stop();
    expect(claimed).toMatchObject({ ok: true, reusedScope: true, checkpoint: { checkpointId: listed[0].checkpoint.checkpointId } });
    expect(claimTrace.operations.some((item) => item.store === RECOVERY_STORE)).toBe(false);
    expect(claimTrace.operations.filter((item) => item.kind === "cursor" && item.store === "checkpoints")).toHaveLength(0);
    expect(claimTrace.operations.filter((item) => item.kind === "get" && item.store === "checkpoints").map((item) => item.key)).toEqual(["scope-0"]);
    expect(claimTrace.operations.filter((item) => item.kind === "get" && item.store === RECOVERY_METADATA_STORE).map((item) => item.key)).toEqual([recoveryStorageKey("tab-0", "scope-0")]);

    const loadTrace = traceIdbOperations();
    const restored = await loadSessionCheckpoint("scope-0", { expectedCheckpointId: listed[0].checkpoint.checkpointId, lease: claimed.lease! });
    loadTrace.stop();
    expect(restored?.recoveries[recoveryStorageKey("tab-0", "scope-0")]?.content).toBe("const tab-0 = 2;");
    expect(loadTrace.operations.filter((item) => item.kind === "get" && item.store === RECOVERY_STORE).map((item) => item.key).sort()).toEqual([
      recoveryStorageKey("tab-0", "scope-0"),
      recoveryBaselineKey("tab-0", "scope-0"),
    ].sort());
    expect(loadTrace.operations.filter((item) => item.kind === "get" && item.store === RECOVERY_STORE).some((item) => String(item.key).includes("scope-1"))).toBe(false);
  });
});

describe("bounded IndexedDB open", () => {
  it("times out a blocked open, notifies the fallback transition, retries, and closes a late success", async () => {
    if (!fakeIndexedDb) throw new Error("fake-indexeddb is required for this test");
    vi.useFakeTimers();
    let request: {
      onblocked?: ((event: Event) => void) | null;
      onsuccess?: ((event: Event) => void) | null;
      onerror?: ((event: Event) => void) | null;
      onupgradeneeded?: ((event: IDBVersionChangeEvent) => void) | null;
      result: IDBDatabase;
    };
    const fakeOpen = vi.fn(() => request as unknown as IDBOpenDBRequest);
    const blockedFactory = { open: fakeOpen } as unknown as IDBFactory;
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: blockedFactory });
    request = { result: {} as IDBDatabase };
    const handler = vi.fn();
    await setRecoveryDatabaseBlockedHandler(handler);

    const pending = openRecoveryDatabase();
    request.onblocked?.(new Event("blocked"));
    expect(handler).toHaveBeenCalledWith(RECOVERY_DATABASE_OPEN_TIMEOUT_MS, "blocked");
    await vi.advanceTimersByTimeAsync(RECOVERY_DATABASE_OPEN_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
    expect(handler).toHaveBeenLastCalledWith(RECOVERY_DATABASE_OPEN_TIMEOUT_MS, "timed-out");

    const close = vi.fn();
    request.result = { close } as unknown as IDBDatabase;
    request.onsuccess?.(new Event("success"));
    expect(close).toHaveBeenCalledOnce();

    vi.useRealTimers();
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDb });
    const retried = await openRecoveryDatabase();
    expect(retried).toBeInstanceOf(IDBDatabase);
    retried?.close();
    expect(fakeOpen).toHaveBeenCalledOnce();
  });
});
