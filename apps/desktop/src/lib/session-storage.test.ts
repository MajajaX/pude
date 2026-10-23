import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  attachSessionWindow,
  claimSessionWindow,
  closeSessionWindow,
  compactRecoverySnapshot,
  commitSessionCheckpoint,
  createSessionMetadata,
  createWindowSessionMetadata,
  discardSessionCheckpoint,
  getRecoveryStorageUsage,
  flushSessionPersistence,
  heartbeatSessionWindow,
  listRecoverableSessionCheckpoints,
  MAX_RECOVERY_BYTES,
  parseCursorPositions,
  parseRecovery,
  parseSessionCheckpoint,
  parseSession,
  readLatestSessionCheckpoint,
  readRecoveryStorage,
  readSessionRegistry,
  recoverySnapshotSizeBytes,
  recoveryStorageKey,
  sessionCheckpointStorageKey,
  SESSION_REGISTRY_STORAGE_KEY,
  serializeCursorPositions,
  writeRecoveryStorage,
  MAX_RECOVERY_TOTAL_BYTES,
  type SessionMetadata,
} from "./session-storage";
import type { DirectoryEntry, EditorTab } from "../types";

const tab: EditorTab = {
  id: "tab-1",
  path: "/workspace/src/main.ts",
  name: "main.ts",
  content: "const value = 1;",
  savedContent: "const value = 0;",
  dirty: true,
  lineEnding: "lf",
  lineEndings: "cl",
  savedLineEndings: "lc",
  bom: true,
  savedBom: true,
  encoding: "UTF-8",
  language: "TypeScript",
  cursorLine: 2,
  cursorColumn: 4,
  revision: 3,
  savedRevision: 2,
  contentVersion: 0,
};

const root: DirectoryEntry = {
  name: "workspace",
  path: "/workspace",
  kind: "directory",
  expanded: true,
  loaded: true,
  children: [{ name: "src", path: "/workspace/src", kind: "directory", expanded: true, loaded: true }],
};

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  failKey: string | undefined;
  maxValueLength: number | undefined;
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) {
    if (this.failKey === key || (this.maxValueLength !== undefined && value.length > this.maxValueLength)) throw new Error("quota");
    this.values.set(key, value);
  }
}

const storage = new MemoryStorage();
const fakeIndexedDb = globalThis.indexedDB;
let fallbackLockTails = new Map<string, Promise<void>>();

async function clearIndexedDb() {
  if (!fakeIndexedDb) return;
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDb });
  await new Promise<void>((resolve) => {
    const request = fakeIndexedDb.deleteDatabase("pude-recovery-v1");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => undefined;
  });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
}

function enableIndexedDb() {
  if (!fakeIndexedDb) throw new Error("fake-indexeddb is required for IndexedDB tests");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDb });
}

function dirtySession(revision: number, savedRevision = revision - 1): SessionMetadata {
  return createSessionMetadata("/workspace", tab.id, [{ ...tab, revision, savedRevision, dirty: true }], root);
}

function recovery(revision: number, content = `const value = ${revision};`) {
  return { ...parseRecovery({ version: 1, tabId: tab.id, path: tab.path, revision, content, savedContent: "const value = 0;", lineEnding: "lf", lineEndings: "cl", savedLineEndings: "lc", bom: true, savedBom: true, encoding: "UTF-8" })! };
}

function boundaryTab(index: number, dirty: boolean): EditorTab {
  return {
    ...tab,
    id: `boundary-tab-${index}`,
    path: `/workspace/src/boundary-${index}.ts`,
    name: `boundary-${index}.ts`,
    content: `const value = ${index};`,
    dirty,
    revision: dirty ? 2 : 1,
    savedRevision: dirty ? 1 : 1,
  };
}

function boundaryRecovery(candidate: EditorTab) {
  return {
    version: 1 as const,
    tabId: candidate.id,
    path: candidate.path,
    revision: candidate.revision,
    content: candidate.content,
    savedContent: candidate.savedContent,
    lineEnding: candidate.lineEnding,
  };
}

beforeEach(async () => {
  await clearIndexedDb();
  fallbackLockTails = new Map();
  storage.clear();
  storage.failKey = undefined;
  storage.maxValueLength = undefined;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async <T>(name: string, _options: { mode: "exclusive" }, callback: () => T | Promise<T>) => {
      const previous = fallbackLockTails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      fallbackLockTails.set(name, current);
      await previous;
      try {
        return await callback();
      } finally {
        release();
        if (fallbackLockTails.get(name) === current) fallbackLockTails.delete(name);
      }
    } } },
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("session storage", () => {
  it("keeps a first checkpoint ahead of an immediate flush while loading the recovery runtime", async () => {
    enableIndexedDb();
    const scope = "cold-lazy-flush";
    const commit = commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });

    await flushSessionPersistence();

    await expect(commit).resolves.toMatchObject({ ok: true, complete: true });
    expect((await readLatestSessionCheckpoint(scope))?.recoveries[recoveryStorageKey(tab.id, scope)]?.revision).toBe(1);
  });

  it("persists BOM and per-line ending metadata with session and recovery state", () => {
    const session = createSessionMetadata("/workspace", tab.id, [tab], root);
    expect(session.tabs[0]).toMatchObject({ lineEndings: "cl", savedLineEndings: "lc", bom: true, savedBom: true });
    const parsed = parseRecovery({ version: 1, tabId: tab.id, path: tab.path, revision: 4, content: "a\nb\nc", savedContent: "c\nd\ne", lineEnding: "lf", lineEndings: "cl", savedLineEndings: "lc", bom: true, savedBom: true, encoding: "UTF-8" });
    expect(parsed).toMatchObject({ lineEndings: "cl", savedLineEndings: "lc", bom: true, savedBom: true, encoding: "UTF-8" });
  });

  it("serializes metadata without document text", () => {
    const session = createSessionMetadata("/workspace", tab.id, [tab], root);
    const raw = JSON.stringify(session);
    expect(raw).not.toContain("const value = 1");
    expect(raw).not.toContain("savedContent");
    expect(session.expandedPaths).toEqual(["/workspace", "/workspace/src"]);
    expect(parseSession(raw)?.tabs[0]).toMatchObject({ id: "tab-1", revision: 3, dirty: true });
  });

  it("persists pinned state and defaults older sessions to unpinned", () => {
    const session = createSessionMetadata("/workspace", tab.id, [
      { ...tab, pinned: true },
      { ...tab, id: "tab-2", path: "/workspace/src/other.ts", name: "other.ts", pinned: false },
    ], root);
    const restored = parseSession(JSON.stringify(session));

    expect(restored?.tabs.map((candidate) => candidate.pinned)).toEqual([true, false]);

    const legacy = JSON.parse(JSON.stringify(session)) as { tabs: Array<Record<string, unknown>> };
    delete legacy.tabs[0].pinned;
    expect(parseSession(JSON.stringify(legacy))?.tabs[0].pinned).toBe(false);
  });

  it("restores pinned state from a committed session checkpoint", async () => {
    const session = createSessionMetadata("/workspace", tab.id, [{ ...tab, content: tab.savedContent, dirty: false, pinned: true }], root);
    const result = await commitSessionCheckpoint({ scope: "pinned-round-trip", session, now: 100 });

    expect(result).toMatchObject({ ok: true, complete: true });
    expect((await readLatestSessionCheckpoint("pinned-round-trip"))?.session.tabs[0].pinned).toBe(true);
  });

  it.each([99, 100, 101])("retains a dirty tab at the %i-tab boundary", async (tabCount) => {
    const tabs = Array.from({ length: tabCount }, (_, index) => boundaryTab(index, index === tabCount - 1));
    const dirtyTab = tabs[tabCount - 1];
    const session = createSessionMetadata("/workspace", dirtyTab.id, tabs, root);

    expect(session.tabs).toHaveLength(tabCount);
    expect(session.tabs.find((candidate) => candidate.id === dirtyTab.id)).toMatchObject({ dirty: true, revision: dirtyTab.revision });

    const scope = `boundary-${tabCount}`;
    const result = await commitSessionCheckpoint({ scope, session, recoveries: [boundaryRecovery(dirtyTab)], now: 100 });
    expect(result).toMatchObject({ ok: true, complete: true });
    const restored = await readLatestSessionCheckpoint(scope);
    expect(restored?.session.tabs).toHaveLength(tabCount);
    expect(restored?.recoveries[recoveryStorageKey(dirtyTab.id, scope)]).toMatchObject({ revision: dirtyTab.revision });
  });

  it("limits clean tabs to the session capacity without affecting dirty tabs", () => {
    const tabs = Array.from({ length: 101 }, (_, index) => boundaryTab(index, false));
    const session = createSessionMetadata("/workspace", tabs[100].id, tabs, root);

    expect(session.tabs).toHaveLength(100);
    expect(session.tabs.map((candidate) => candidate.id)).not.toContain(tabs[100].id);
  });

  it("ignores malformed session data and validates cursor records", () => {
    expect(parseSession("{bad json")).toBeNull();
    const raw = serializeCursorPositions({ "tab-1": { cursorLine: 4, cursorColumn: 2 } });
    expect(parseCursorPositions(raw)).toEqual({ "tab-1": { cursorLine: 4, cursorColumn: 2 } });
    expect(parseCursorPositions(JSON.stringify({ version: 1, positions: {} }))).toEqual({});
  });

  it("parses an IndexedDB structured recovery snapshot without JSON serialization", () => {
    const recovery = {
      version: 1 as const,
      tabId: tab.id,
      path: tab.path,
      revision: tab.revision,
      content: tab.content,
      savedContent: tab.savedContent,
      lineEnding: tab.lineEnding,
    };
    expect(parseRecovery(recovery)).toEqual(recovery);
  });

  it("commits session metadata and recovery revision as one complete checkpoint", async () => {
    const result = await commitSessionCheckpoint({ scope: "main", session: dirtySession(3, 2), recoveries: [recovery(3)], now: 100 });
    expect(result).toMatchObject({ ok: true, complete: true, durability: "fallback", fallback: "committed" });
    const restored = await readLatestSessionCheckpoint("main");
    expect(restored?.session.tabs[0]).toMatchObject({ revision: 3, savedRevision: 2, dirty: true });
    expect(restored?.recoveryRevisions[recoveryStorageKey(tab.id, "main")]).toBe(3);
    expect(restored?.recoveries[recoveryStorageKey(tab.id, "main")].content).toBe("const value = 3;");
  });

  it("serializes concurrent checkpoints and restores the highest complete sequence", async () => {
    await commitSessionCheckpoint({ scope: "main", session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    const results = await Promise.all([
      commitSessionCheckpoint({ scope: "main", session: dirtySession(2), recoveries: [recovery(2)], now: 200 }),
      commitSessionCheckpoint({ scope: "main", session: dirtySession(3), recoveries: [recovery(3)], now: 300 }),
    ]);
    expect(results.every((result) => result.ok && result.complete)).toBe(true);
    const restored = await readLatestSessionCheckpoint("main");
    expect(restored?.sequence).toBe(3);
    expect(restored?.recoveries[recoveryStorageKey(tab.id, "main")].revision).toBe(3);
  });

  it("keeps the last complete checkpoint when a dirty snapshot is missing", async () => {
    await commitSessionCheckpoint({ scope: "main", session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    const rejected = await commitSessionCheckpoint({ scope: "main", session: dirtySession(2), now: 200 });
    expect(rejected).toMatchObject({ ok: false, complete: false, reason: "missing-recovery" });
    expect(rejected.missingRecoveryKeys).toEqual([recoveryStorageKey(tab.id, "main")]);
    expect((await readLatestSessionCheckpoint("main"))?.sequence).toBe(1);
  });

  it("rejects metadata that advanced beyond the last recovery revision", async () => {
    await commitSessionCheckpoint({ scope: "main", session: dirtySession(5), recoveries: [recovery(5)], now: 100 });
    const rejected = await commitSessionCheckpoint({ scope: "main", session: dirtySession(10, 2), now: 200 });
    expect(rejected).toMatchObject({ ok: false, reason: "missing-recovery" });
    expect((await readLatestSessionCheckpoint("main"))?.session.tabs[0].revision).toBe(5);
  });

  it("rejects a previous recovery snapshot after its tab path changes", async () => {
    await commitSessionCheckpoint({ scope: "main", session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    const renamed = createSessionMetadata("/workspace", tab.id, [{ ...tab, path: "/workspace/src/renamed.ts", revision: 2, savedRevision: 1, dirty: true }], root);
    const rejected = await commitSessionCheckpoint({ scope: "main", session: renamed, now: 200 });
    expect(rejected).toMatchObject({ ok: false, reason: "missing-recovery" });
    expect((await readLatestSessionCheckpoint("main"))?.session.tabs[0].path).toBe(tab.path);
  });

  it("does not borrow an older snapshot when a new revision is over the per-document limit", async () => {
    await commitSessionCheckpoint({ scope: "main", session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    const rejected = await commitSessionCheckpoint({
      scope: "main",
      session: dirtySession(2),
      recoveries: [{
        version: 1,
        tabId: tab.id,
        path: tab.path,
        revision: 2,
        content: "x".repeat(Math.floor(MAX_RECOVERY_BYTES / 2) + 1),
        savedContent: "",
    lineEnding: "lf",
    lineEndings: "cl",
    savedLineEndings: "lc",
    bom: true,
    savedBom: true,
      }],
      now: 200,
    });
    expect(rejected.missingRecoveryKeys).toEqual([recoveryStorageKey(tab.id, "main")]);
    expect((await readLatestSessionCheckpoint("main"))?.recoveries[recoveryStorageKey(tab.id, "main")].revision).toBe(1);
  });

  it("does not claim complete when the caller reports an unavailable dirty snapshot", async () => {
    await commitSessionCheckpoint({ scope: "main", session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    const key = recoveryStorageKey(tab.id, "main");
    const rejected = await commitSessionCheckpoint({ scope: "main", session: dirtySession(1), recoveries: [recovery(1)], unavailableRecoveryKeys: [key], now: 200 });
    expect(rejected).toMatchObject({ ok: false, complete: false, reason: "missing-recovery" });
    expect((await readLatestSessionCheckpoint("main"))?.sequence).toBe(1);
  });

  it("retains the previous checkpoint when fallback storage rejects its replacement", async () => {
    await commitSessionCheckpoint({ scope: "main", session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    storage.failKey = "pude-session-checkpoint-v1:main";
    const rejected = await commitSessionCheckpoint({ scope: "main", session: dirtySession(2), recoveries: [recovery(2)], now: 200 });
    expect(rejected.ok).toBe(false);
    expect((await readLatestSessionCheckpoint("main"))?.sequence).toBe(1);
  });

  it("protects dirty recovery keys registered by another window from quota eviction", async () => {
    enableIndexedDb();
    const protectedKey = recoveryStorageKey("protected", "other");
    const protectedSnapshot = { ...recovery(1), tabId: "protected", path: "/workspace/protected.ts" };
    await attachSessionWindow({ windowId: "other-window", scope: "other", workspace: "/workspace", dirtyRecoveryKeys: [protectedKey], now: 100 });
    await writeRecoveryStorage(protectedKey, protectedSnapshot);
    const huge = "x".repeat(3_900_000);
    const largeSnapshot = { ...recovery(2, huge), tabId: tab.id, path: tab.path };
    const first = await commitSessionCheckpoint({ scope: "main", session: dirtySession(2), recoveries: [largeSnapshot], now: 200 });
    expect(first.ok).toBe(true);
    const usage = await getRecoveryStorageUsage();
    expect(usage.totalBytes).toBeLessThanOrEqual(MAX_RECOVERY_TOTAL_BYTES);
    expect(await readRecoveryStorage(protectedKey)).not.toBeNull();
  });

  it("keeps stale dirty leases until an explicit close policy clears them", async () => {
    const dirtyKey = recoveryStorageKey(tab.id, "main");
    const attached = await attachSessionWindow({ windowId: "window-1", scope: "main", workspace: "/workspace", dirtyRecoveryKeys: [dirtyKey], now: 100 });
    expect(attached.lease).not.toBeNull();
    const stale = await readSessionRegistry(100 + 2 * 60 * 60 * 1000);
    expect(stale.windows[0]).toMatchObject({ status: "open", dirtyRecoveryKeys: [dirtyKey] });
    const closed = await closeSessionWindow(attached.lease!, { now: 200 });
    expect(closed.registry.windows[0]).toMatchObject({ status: "closed", dirtyRecoveryKeys: [dirtyKey] });
    const discarded = await closeSessionWindow(attached.lease!, { discardRecovery: true, now: 300 });
    expect(discarded).toMatchObject({ ok: true, registry: { windows: [] } });
  });

  it("reports unavailable when neither registry store can be read", async () => {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("storage blocked"); } });

    const result = await closeSessionWindow({ windowId: "unknown-owner", scope: "unknown-scope", leaseId: "unknown-lease" }, { now: 200 });

    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("does not report a stale lease when closing an observed owner fails to persist", async () => {
    enableIndexedDb();
    const attached = await attachSessionWindow({ windowId: "write-failure-owner", scope: "write-failure-scope", workspace: "/workspace", now: 100 });
    expect(attached.lease).not.toBeNull();
    storage.failKey = SESSION_REGISTRY_STORAGE_KEY;

    const originalPut = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, value, key);
      if (this.name === "registry" && this.transaction.mode === "readwrite") this.transaction.abort();
      return request;
    });
    try {
      const result = await closeSessionWindow(attached.lease!, { now: 200 });
      expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    } finally {
      putSpy.mockRestore();
    }
  });

  it("reports a stale lease only after both stores successfully prove it is missing", async () => {
    enableIndexedDb();

    const result = await closeSessionWindow({ windowId: "missing-owner", scope: "missing-scope", leaseId: "missing-lease" }, { now: 200 });

    expect(result).toMatchObject({ ok: false, reason: "stale-lease" });
  });

  it("reports stale scopes and atomically hands one over when explicitly claimed", async () => {
    const scope = "crashed-window";
    await commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    const attached = await attachSessionWindow({ windowId: "crashed-window-id", scope, workspace: "/workspace", dirtyRecoveryKeys: [recoveryStorageKey(tab.id, scope)], now: 100 });
    const listed = await listRecoverableSessionCheckpoints("/workspace");
    expect(listed.find((candidate) => candidate.checkpoint.scope === scope)).toMatchObject({ staleWindowIds: ["crashed-window-id"], activeWindowIds: [], closedWindowIds: [] });

    const claimed = await claimSessionWindow({ windowId: "restarted-window-id", workspace: "/workspace", preferredScope: scope, allowStale: true, now: 100 + 2 * 60 * 60 * 1000 });
    expect(claimed).toMatchObject({ ok: true, reusedScope: true, lease: { windowId: "restarted-window-id", scope } });
    expect(claimed.registry.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ windowId: "crashed-window-id", status: "closed", dirtyRecoveryKeys: [recoveryStorageKey(tab.id, scope)] }),
      expect.objectContaining({ windowId: "restarted-window-id", status: "open" }),
    ]));
    expect(attached.lease).not.toBeNull();
    const oldHeartbeat = await heartbeatSessionWindow(attached.lease!, [recoveryStorageKey(tab.id, scope)], 100 + 2 * 60 * 60 * 1000 + 1);
    expect(oldHeartbeat).toMatchObject({ ok: false, reason: "stale-lease" });
    const oldCommit = await commitSessionCheckpoint({ scope, session: dirtySession(2), recoveries: [recovery(2)], lease: attached.lease!, now: 100 + 2 * 60 * 60 * 1000 + 2 });
    expect(oldCommit).toMatchObject({ ok: false, reason: "invalid" });
    await closeSessionWindow(claimed.lease!, { discardRecovery: true, now: 100 + 2 * 60 * 60 * 1000 + 3 });
    expect((await readSessionRegistry()).windows.filter((entry) => entry.scope === scope)).toEqual([]);
  });

  it("serializes concurrent registry attaches without losing either window", async () => {
    const [first, second] = await Promise.all([
      attachSessionWindow({ windowId: "window-a", scope: "scope-a", workspace: "/workspace", now: 100 }),
      attachSessionWindow({ windowId: "window-b", scope: "scope-b", workspace: "/workspace", now: 101 }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((await readSessionRegistry()).windows.map((entry) => entry.windowId)).toEqual(expect.arrayContaining(["window-a", "window-b"]));
  });

  it("rejects a second live owner for one scope", async () => {
    expect((await attachSessionWindow({ windowId: "owner-a", scope: "shared", workspace: "/workspace", now: 100 })).ok).toBe(true);
    expect(await attachSessionWindow({ windowId: "owner-b", scope: "shared", workspace: "/workspace", now: 101 })).toMatchObject({ ok: false, reason: "conflict" });
    expect((await readSessionRegistry()).windows.map((entry) => entry.windowId)).toEqual(["owner-a"]);
  });

  it("rejects a no-lease checkpoint after a second window loses the ownership race", async () => {
    const scope = "owned-checkpoint";
    await commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    const owner = await attachSessionWindow({ windowId: "owner-a", scope, workspace: "/workspace", dirtyRecoveryKeys: [recoveryStorageKey(tab.id, scope)], now: 101 });
    expect(owner.ok).toBe(true);
    expect(await attachSessionWindow({ windowId: "owner-b", scope, workspace: "/workspace", now: 102 })).toMatchObject({ ok: false, reason: "conflict" });
    const rejected = await commitSessionCheckpoint({ scope, session: dirtySession(2), recoveries: [recovery(2)], now: 103 });
    expect(rejected).toMatchObject({ ok: false, reason: "conflict" });
    expect(await readLatestSessionCheckpoint(scope)).toMatchObject({ sequence: 1, recoveries: { [recoveryStorageKey(tab.id, scope)]: { revision: 1 } } });
  });

  it("reports an unavailable fallback registry when Web Locks are missing", async () => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    await expect(attachSessionWindow({ windowId: "window-no-lock", scope: "scope-no-lock", workspace: "/workspace", now: 100 })).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    await expect(commitSessionCheckpoint({ scope: "scope-no-lock", session: dirtySession(1), recoveries: [recovery(1)], now: 100 })).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    await expect(discardSessionCheckpoint("scope-no-lock")).resolves.toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("keeps the last fallback checkpoint when both IndexedDB and Web Locks are unavailable", async () => {
    const scope = "fallback-survives-storage-loss";
    await commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    await clearIndexedDb();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });

    await expect(commitSessionCheckpoint({ scope, session: dirtySession(2), recoveries: [recovery(2)], now: 200 })).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    await expect(discardSessionCheckpoint(scope)).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    const retained = await readLatestSessionCheckpoint(scope);
    expect(retained?.sequence).toBe(1);
    expect(retained?.recoveries[recoveryStorageKey(tab.id, scope)].revision).toBe(1);
  });

  it.each([20, 100, 101])("commits all %i dirty tabs in one complete checkpoint", async (count) => {
    const tabs = Array.from({ length: count }, (_, index) => boundaryTab(index, true));
    const session = createSessionMetadata("/workspace", tabs[0].id, tabs, root);
    const recoveries = tabs.map(boundaryRecovery);
    const result = await commitSessionCheckpoint({ scope: `many-tabs-${count}`, session, recoveries, now: 100 });

    expect(result).toMatchObject({ ok: true, complete: true });
    expect(result.checkpoint?.session.tabs).toHaveLength(count);
    expect(result.updatedRecoveryKeys).toHaveLength(count);
  });

  it.each([5, 20])("recovers a %i MiB dirty document without duplicating its saved baseline when needed", async (sizeMiB) => {
    enableIndexedDb();
    storage.maxValueLength = 5_000_000;
    const scope = "large-document";
    await commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });

    const content = "x".repeat(sizeMiB * 1024 * 1024);
    const fullSnapshot = {
      version: 1 as const,
      tabId: tab.id,
      path: tab.path,
      revision: 2,
      content,
      savedContent: "s".repeat(content.length),
      lineEnding: "lf" as const,
    };
    const compacted = compactRecoverySnapshot(fullSnapshot);
    if (sizeMiB === 20) expect(compacted).toMatchObject({ savedContent: "", savedContentUnavailable: true });
    else expect(compacted?.savedContentUnavailable).toBeUndefined();
    expect(recoverySnapshotSizeBytes(compacted!)).toBeLessThanOrEqual(MAX_RECOVERY_BYTES);

    const largeTab = { ...tab, revision: 2, savedRevision: 1, content, dirty: true };
    const result = await commitSessionCheckpoint({
      scope,
      session: createSessionMetadata("/workspace", tab.id, [largeTab], root),
      recoveries: [compacted!],
      now: 200,
    });
    expect(result).toMatchObject({ ok: true, complete: true, durability: "indexeddb" });
    const committedRecovery = (await readLatestSessionCheckpoint(scope))?.recoveries[recoveryStorageKey(tab.id, scope)];
    expect(committedRecovery?.revision).toBe(2);
    expect(committedRecovery?.savedContentUnavailable).toBe(sizeMiB === 20 ? true : undefined);
    expect(committedRecovery?.savedContent.length).toBe(sizeMiB === 20 ? 0 : content.length);

    vi.resetModules();
    const restartedModule = await import("./session-storage");
    const restored = await restartedModule.readLatestSessionCheckpoint(scope);
    expect(restored?.recoveries[recoveryStorageKey(tab.id, scope)].content === content).toBe(true);
    expect(restored?.session.tabs[0].revision).toBe(2);
  });

  it("serializes cross-window claim and discard when Web Locks are unavailable", async () => {
    enableIndexedDb();
    const scope = "claim-discard-race";
    await commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    storage.setItem(SESSION_REGISTRY_STORAGE_KEY, JSON.stringify({
      version: 1,
      revision: 1,
      updatedAt: 200,
      windows: [{
        windowId: "closed-owner",
        scope,
        leaseId: "closed-owner-lease",
        workspace: "/workspace",
        attachedAt: 100,
        heartbeatAt: 200,
        dirtyRecoveryKeys: [],
        status: "closed",
        closedAt: 200,
      }],
    }));
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });

    const claimModule = await import("./session-storage");
    vi.resetModules();
    const discardModule = await import("./session-storage");
    const [claimed, discarded] = await Promise.all([
      claimModule.claimSessionWindow({ windowId: "new-owner", workspace: "/workspace", preferredScope: scope, now: 300 }),
      discardModule.discardSessionCheckpoint(scope),
    ]);
    const checkpoint = await discardModule.readLatestSessionCheckpoint(scope);
    const registry = await discardModule.readSessionRegistry();

    if (claimed.ok && claimed.reusedScope) {
      expect(discarded).toMatchObject({ ok: false, reason: "protected" });
      expect(checkpoint?.sequence).toBe(1);
      expect(registry.windows).toContainEqual(expect.objectContaining({ windowId: "new-owner", status: "open" }));
    } else {
      expect(discarded.ok).toBe(true);
      expect(checkpoint).toBeNull();
    }

    const claimFirstScope = "claim-before-discard";
    await claimModule.commitSessionCheckpoint({ scope: claimFirstScope, session: dirtySession(1), recoveries: [recovery(1)], now: 400 });
    storage.setItem(SESSION_REGISTRY_STORAGE_KEY, JSON.stringify({
      version: 1,
      revision: 1000,
      updatedAt: 400,
      windows: [{
        windowId: "closed-owner-2",
        scope: claimFirstScope,
        leaseId: "closed-owner-lease-2",
        workspace: "/workspace",
        attachedAt: 300,
        heartbeatAt: 400,
        dirtyRecoveryKeys: [],
        status: "closed",
        closedAt: 400,
      }],
    }));
    const claimFirst = await claimModule.claimSessionWindow({
      windowId: "claim-first-owner",
      workspace: "/workspace",
      preferredScope: claimFirstScope,
      now: 500,
    });
    expect(claimFirst).toMatchObject({ ok: true, reusedScope: true });
    await expect(discardModule.discardSessionCheckpoint(claimFirstScope)).resolves.toMatchObject({ ok: false, reason: "protected" });
    expect(await discardModule.readLatestSessionCheckpoint(claimFirstScope)).toMatchObject({ sequence: 1 });
  });

  it("does not return a claimed lease when the IndexedDB registry transaction aborts", async () => {
    enableIndexedDb();
    const scope = "aborted-claim";
    await commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    storage.setItem(SESSION_REGISTRY_STORAGE_KEY, JSON.stringify({
      version: 1,
      revision: 1000,
      updatedAt: 200,
      windows: [{
        windowId: "closed-owner",
        scope,
        leaseId: "closed-owner-lease",
        workspace: "/workspace",
        attachedAt: 100,
        heartbeatAt: 200,
        dirtyRecoveryKeys: [],
        status: "closed",
        closedAt: 200,
      }],
    }));
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });

    const originalPut = IDBObjectStore.prototype.put;
    let abortClaim = true;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, value, key);
      if (abortClaim && this.name === "registry" && this.transaction.objectStoreNames.contains("checkpoints")) {
        abortClaim = false;
        this.transaction.abort();
      }
      return request;
    });
    try {
      const claimed = await claimSessionWindow({ windowId: "aborted-owner", workspace: "/workspace", preferredScope: scope, now: 300 });
      expect(claimed).toMatchObject({ ok: false, lease: null, reusedScope: false, reason: "unavailable" });
      expect(await readLatestSessionCheckpoint(scope)).toMatchObject({ sequence: 1 });
      expect((await readSessionRegistry()).windows).not.toContainEqual(expect.objectContaining({ windowId: "aborted-owner", status: "open" }));
    } finally {
      putSpy.mockRestore();
    }
  });

  it("rejects a new window when all registry slots protect active or dirty leases", async () => {
    storage.setItem(SESSION_REGISTRY_STORAGE_KEY, JSON.stringify({
      version: 1,
      revision: 1,
      updatedAt: 1,
      windows: Array.from({ length: 256 }, (_, index) => ({
        windowId: `window-${index}`,
        scope: `scope-${index}`,
        leaseId: `lease-${index}`,
        workspace: "/workspace",
        attachedAt: index,
        heartbeatAt: index,
        dirtyRecoveryKeys: [recoveryStorageKey(`tab-${index}`, `scope-${index}`)],
        status: "open",
      })),
    }));
    const result = await attachSessionWindow({ windowId: "window-new", scope: "scope-new", workspace: "/workspace", now: 300 });
    expect(result).toMatchObject({ ok: false, reason: "capacity" });
    expect((await readSessionRegistry()).windows).toHaveLength(256);
    expect((await readSessionRegistry()).windows.map((entry) => entry.windowId)).not.toContain("window-new");
  });

  it("prunes only clean closed leases when a registry slot is needed", async () => {
    storage.setItem(SESSION_REGISTRY_STORAGE_KEY, JSON.stringify({
      version: 1,
      revision: 1,
      updatedAt: 1,
      windows: [
        {
          windowId: "clean-closed",
          scope: "clean-scope",
          leaseId: "clean-lease",
          workspace: "/workspace",
          attachedAt: 1,
          heartbeatAt: 1,
          dirtyRecoveryKeys: [],
          status: "closed",
          closedAt: 2,
        },
        ...Array.from({ length: 255 }, (_, index) => ({
          windowId: `protected-${index}`,
          scope: `protected-scope-${index}`,
          leaseId: `protected-lease-${index}`,
          workspace: "/workspace",
          attachedAt: index + 3,
          heartbeatAt: index + 3,
          dirtyRecoveryKeys: [recoveryStorageKey(`tab-${index}`, `protected-scope-${index}`)],
          status: "open",
        })),
      ],
    }));
    const result = await attachSessionWindow({ windowId: "window-new", scope: "scope-new", workspace: "/workspace", now: 300 });
    expect(result).toMatchObject({ ok: true, lease: { windowId: "window-new" } });
    expect((await readSessionRegistry()).windows).toHaveLength(256);
    expect((await readSessionRegistry()).windows.map((entry) => entry.windowId)).not.toContain("clean-closed");
  });

  it("requires explicit discard before removing a dirty checkpoint", async () => {
    const scope = "discard-me";
    const key = recoveryStorageKey(tab.id, scope);
    await commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    const attached = await attachSessionWindow({ windowId: "discard-window", scope, workspace: "/workspace", dirtyRecoveryKeys: [key], now: 100 });
    expect(await discardSessionCheckpoint(scope)).toMatchObject({ ok: false, reason: "protected" });
    await closeSessionWindow(attached.lease!, { now: 200 });
    expect(await discardSessionCheckpoint(scope)).toMatchObject({ ok: false, reason: "protected" });
    await closeSessionWindow(attached.lease!, { discardRecovery: true, now: 300 });
    expect(await discardSessionCheckpoint(scope)).toMatchObject({ ok: true });
    expect(await readLatestSessionCheckpoint(scope)).toBeNull();
  });

  it("rejects a checkpoint whose revision marker does not match its snapshot", () => {
    const key = recoveryStorageKey(tab.id, "main");
    const raw = {
      version: 1,
      scope: "main",
      checkpointId: "main:1:test",
      sequence: 1,
      committedAt: 100,
      session: dirtySession(2),
      recoveryRevisions: { [key]: 2 },
      recoveries: { [key]: recovery(1) },
    };
    expect(parseSessionCheckpoint(raw)).toBeNull();
  });

  it("rejects a checkpoint that pairs newer metadata with an older recovery", () => {
    const key = recoveryStorageKey(tab.id, "main");
    const raw = {
      version: 1,
      scope: "main",
      checkpointId: "main:1:test",
      sequence: 1,
      committedAt: 100,
      session: dirtySession(10),
      recoveryRevisions: { [key]: 5 },
      recoveries: { [key]: recovery(5) },
    };
    expect(parseSessionCheckpoint(raw)).toBeNull();
  });

  it("commits the IndexedDB marker and recovery in one readable transaction", async () => {
    enableIndexedDb();
    const scope = "idb-atomic";
    const result = await commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    expect(result).toMatchObject({ ok: true, complete: true });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = fakeIndexedDb!.open("pude-recovery-v1", 4);
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
    const key = recoveryStorageKey(tab.id, scope);
    const values = await new Promise<{ marker: unknown; snapshot: unknown }>((resolve, reject) => {
      const transaction = database.transaction(["checkpoints", "snapshots"], "readonly");
      let marker: unknown;
      let snapshot: unknown;
      transaction.objectStore("checkpoints").get(scope).onsuccess = (event) => { marker = (event.target as IDBRequest).result; };
      transaction.objectStore("snapshots").get(key).onsuccess = (event) => { snapshot = (event.target as IDBRequest).result; };
      transaction.oncomplete = () => resolve({ marker, snapshot });
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    expect(values.marker).toMatchObject({ checkpoint: { scope, sequence: 1 }, recoveryKeys: [key] });
    expect(values.snapshot).toMatchObject({ value: { tabId: tab.id, path: tab.path, revision: 1 } });
  });

  it("allows only one live owner when separate module instances claim one scope", async () => {
    enableIndexedDb();
    const scope = "idb-claim-race";
    await commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    const oldWindow = await attachSessionWindow({ windowId: "closed-owner", scope, workspace: "/workspace", dirtyRecoveryKeys: [recoveryStorageKey(tab.id, scope)], now: 100 });
    await closeSessionWindow(oldWindow.lease!, { now: 200 });

    const firstModule = await import("./session-storage");
    vi.resetModules();
    const secondModule = await import("./session-storage");
    storage.failKey = sessionCheckpointStorageKey(scope);
    const [first, second] = await Promise.all([
      firstModule.claimSessionWindow({ windowId: "claim-a", workspace: "/workspace", preferredScope: scope, now: 100 + 2 * 60 * 60 * 1000 }),
      secondModule.claimSessionWindow({ windowId: "claim-b", workspace: "/workspace", preferredScope: scope, now: 100 + 2 * 60 * 60 * 1000 }),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect([first, second].find((candidate) => candidate.ok)).toMatchObject({ reusedScope: true, lease: { scope } });
  });

  it("fences an old lease while a takeover is mirroring its committed IDB registry", async () => {
    enableIndexedDb();
    const scope = "takeover-interleave";
    await commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    const oldWindow = await attachSessionWindow({ windowId: "old-owner", scope, workspace: "/workspace", dirtyRecoveryKeys: [recoveryStorageKey(tab.id, scope)], now: 100 });
    expect(oldWindow.lease).not.toBeNull();

    const originalSetItem = storage.setItem.bind(storage);
    let oldCommitPromise: ReturnType<typeof commitSessionCheckpoint> | undefined;
    storage.setItem = (key: string, value: string) => {
      if (!oldCommitPromise && key === SESSION_REGISTRY_STORAGE_KEY && value.includes("new-owner")) {
        oldCommitPromise = commitSessionCheckpoint({ scope, session: dirtySession(2), recoveries: [recovery(2)], lease: oldWindow.lease!, now: 100 + 2 * 60 * 60 * 1000 + 1 });
      }
      originalSetItem(key, value);
    };
    try {
      const takeover = await claimSessionWindow({ windowId: "new-owner", workspace: "/workspace", preferredScope: scope, allowStale: true, now: 100 + 2 * 60 * 60 * 1000 });
      expect(takeover.ok).toBe(true);
      expect(oldCommitPromise).toBeDefined();
      await expect(oldCommitPromise!).resolves.toMatchObject({ ok: false, reason: "invalid" });
      expect((await readLatestSessionCheckpoint(scope))?.sequence).toBe(1);
    } finally {
      storage.setItem = originalSetItem;
    }
  });

  it("keeps checkpoint sequences monotonic across separate module instances", async () => {
    enableIndexedDb();
    const scope = "idb-checkpoint-race";
    await commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    const attached = await attachSessionWindow({ windowId: "checkpoint-owner", scope, workspace: "/workspace", dirtyRecoveryKeys: [recoveryStorageKey(tab.id, scope)], now: 100 });
    const firstModule = await import("./session-storage");
    vi.resetModules();
    const secondModule = await import("./session-storage");
    const [first, second] = await Promise.all([
      firstModule.commitSessionCheckpoint({ scope, session: dirtySession(2), recoveries: [recovery(2)], lease: attached.lease!, now: 200 }),
      secondModule.commitSessionCheckpoint({ scope, session: dirtySession(2), recoveries: [recovery(2)], lease: attached.lease!, now: 201 }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((await readLatestSessionCheckpoint(scope))?.sequence).toBe(3);
    expect((await readLatestSessionCheckpoint(scope))?.recoveries[recoveryStorageKey(tab.id, scope)].revision).toBe(2);
  });

  it("merges a newer fallback registry before migrating it into IndexedDB", async () => {
    const dirtyKey = recoveryStorageKey("fallback-tab", "fallback-scope");
    storage.setItem(SESSION_REGISTRY_STORAGE_KEY, JSON.stringify({
      version: 1,
      revision: 3,
      updatedAt: 300,
      windows: [{
        windowId: "fallback-owner",
        scope: "fallback-scope",
        leaseId: "fallback-lease",
        workspace: "/workspace",
        attachedAt: 100,
        heartbeatAt: 300,
        dirtyRecoveryKeys: [dirtyKey],
        status: "open",
      }],
    }));
    enableIndexedDb();
    const attached = await attachSessionWindow({ windowId: "migrating-window", scope: "migrating-scope", workspace: "/workspace", now: 400 });
    expect(attached).toMatchObject({ ok: true, lease: { scope: "migrating-scope" } });
    expect(attached.registry.revision).toBe(4);
    expect(attached.registry.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ windowId: "fallback-owner", dirtyRecoveryKeys: [dirtyKey] }),
      expect.objectContaining({ windowId: "migrating-window", scope: "migrating-scope" }),
    ]));
    expect((await readSessionRegistry()).windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ windowId: "fallback-owner", dirtyRecoveryKeys: [dirtyKey] }),
    ]));
  });

  it("aborts an over-quota IndexedDB checkpoint without replacing the prior marker", async () => {
    enableIndexedDb();
    const scope = "idb-quota";
    await commitSessionCheckpoint({ scope, session: dirtySession(1), recoveries: [recovery(1)], now: 100 });
    storage.failKey = sessionCheckpointStorageKey(scope);
    const hugeContent = "x".repeat(5_200_000);
    const tabs = Array.from({ length: 5 }, (_, index) => ({
      ...tab,
      id: `quota-tab-${index}`,
      path: `/workspace/src/quota-${index}.ts`,
      name: `quota-${index}.ts`,
      revision: 2,
      savedRevision: 1,
      content: hugeContent,
      savedContent: "",
    }));
    const session = createSessionMetadata("/workspace", tabs[0].id, tabs, root);
    const recoveries = tabs.map((candidate) => ({
      version: 1 as const,
      tabId: candidate.id,
      path: candidate.path,
      revision: candidate.revision,
      content: candidate.content,
      savedContent: candidate.savedContent,
      lineEnding: candidate.lineEnding,
    }));
    const result = await commitSessionCheckpoint({ scope, session, recoveries, now: 200 });
    expect(result).toMatchObject({ ok: false, complete: false, reason: "quota" });
    const retained = await readLatestSessionCheckpoint(scope);
    expect(retained?.sequence).toBe(1);
    expect(retained?.recoveries[recoveryStorageKey(tab.id, scope)].revision).toBe(1);
  });
});

function multiProjectSession() {
  const otherTab = { ...tab, id: "tab-other-project", content: "background edit" };
  const first = createSessionMetadata("/workspace", tab.id, [tab], root);
  const second = createSessionMetadata("/workspace/src", otherTab.id, [otherTab], root);
  return {
    otherTab,
    session: createWindowSessionMetadata([
      { id: "first", workspace: first.workspace, activeTabId: first.activeTabId, tabs: first.tabs, expandedPaths: first.expandedPaths },
      { id: "second", workspace: second.workspace, activeTabId: second.activeTabId, tabs: second.tabs, expandedPaths: second.expandedPaths },
    ], "second"),
  };
}

describe("multi-project window recovery", () => {
  it("round trips overlapping roots and the same file with independent document IDs", () => {
    const { session } = multiProjectSession();
    const restored = parseSession(JSON.stringify(session))!;
    expect(restored.version).toBe(3);
    expect(restored.activeProjectId).toBe("second");
    expect(restored.projects?.map((project) => project.id)).toEqual(["first", "second"]);
    expect(restored.tabs.map((item) => item.id)).toEqual([tab.id, "tab-other-project"]);
    expect(restored.tabs.map((item) => item.path)).toEqual([tab.path, tab.path]);
  });

  it("round trips the folders and file of a multi-folder workspace", () => {
    const { session } = multiProjectSession();
    session.projects![0] = { ...session.projects![0], folders: ["/api", "/api", 42 as unknown as string], workspaceFile: "/work/team.pdw" };
    const restored = parseSession(JSON.stringify(session))!;
    expect(restored.projects?.[0]).toMatchObject({ folders: ["/api"], workspaceFile: "/work/team.pdw" });
    expect(restored.projects?.[1]).not.toHaveProperty("folders");
    expect(restored.projects?.[1]).not.toHaveProperty("workspaceFile");
  });

  it("accepts old single-project sessions and rejects duplicate cross-project document IDs", () => {
    const legacy = { ...dirtySession(3), version: 2 };
    expect(parseSession(JSON.stringify(legacy))).toMatchObject({ version: 3, workspace: "/workspace", tabs: [{ id: tab.id }] });
    const { session } = multiProjectSession();
    session.projects![1].tabs[0].id = tab.id;
    expect(parseSession(JSON.stringify(session))).toBeNull();
  });

  it("protects all projects with one lease and preserves their recovery after closing", async () => {
    const { session, otherTab } = multiProjectSession();
    const scope = "multi-project-preserve";
    const attached = await attachSessionWindow({ windowId: "window", scope, workspace: session.workspace });
    const result = await commitSessionCheckpoint({ scope, session, lease: attached.lease!, recoveries: [boundaryRecovery(tab), boundaryRecovery(otherTab)] });
    expect(result).toMatchObject({ ok: true, complete: true });
    const registry = await readSessionRegistry();
    expect(registry.windows).toHaveLength(1);
    expect(registry.windows[0].dirtyRecoveryKeys.sort()).toEqual([recoveryStorageKey(tab.id, scope), recoveryStorageKey(otherTab.id, scope)].sort());
    await closeSessionWindow(attached.lease!);
    const checkpoint = await readLatestSessionCheckpoint(scope);
    expect(checkpoint?.session.projects).toHaveLength(2);
    expect(checkpoint?.recoveries[recoveryStorageKey(otherTab.id, scope)].content).toBe("background edit");
  });

  it("does not report a complete checkpoint when a background project has no recovery", async () => {
    const { session, otherTab } = multiProjectSession();
    const scope = "multi-project-incomplete";
    const result = await commitSessionCheckpoint({ scope, session, recoveries: [boundaryRecovery(tab)] });
    expect(result.complete).toBe(false);
    expect(result.missingRecoveryKeys).toContain(recoveryStorageKey(otherTab.id, scope));
  });

  it("retains parked recovery when only the selected project changes", async () => {
    const { session, otherTab } = multiProjectSession();
    const scope = "multi-project-parked";
    await commitSessionCheckpoint({ scope, session, recoveries: [boundaryRecovery(tab), boundaryRecovery(otherTab)] });
    const selected = createWindowSessionMetadata(session.projects!, "first");
    const result = await commitSessionCheckpoint({ scope, session: selected });
    expect(result).toMatchObject({ ok: true, complete: true });
    const checkpoint = await readLatestSessionCheckpoint(scope);
    expect(checkpoint?.session.activeProjectId).toBe("first");
    expect(checkpoint?.recoveries[recoveryStorageKey(otherTab.id, scope)].content).toBe("background edit");
  });

  it("retains the complete multi-project checkpoint when storage rejects a new commit", async () => {
    const { session, otherTab } = multiProjectSession();
    const scope = "multi-project-storage-failure";
    await commitSessionCheckpoint({ scope, session, recoveries: [boundaryRecovery(tab), boundaryRecovery(otherTab)] });
    storage.failKey = sessionCheckpointStorageKey(scope);
    const result = await commitSessionCheckpoint({ scope, session: createWindowSessionMetadata(session.projects!, "first") });
    expect(result).toMatchObject({ ok: false, complete: false, reason: "unavailable" });
    const checkpoint = await readLatestSessionCheckpoint(scope);
    expect(checkpoint?.sequence).toBe(1);
    expect(checkpoint?.session.activeProjectId).toBe("second");
    expect(checkpoint?.recoveries[recoveryStorageKey(otherTab.id, scope)].content).toBe("background edit");
  });
});
