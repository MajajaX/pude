import { beforeEach, afterEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import {
  baselineKeyForRecoveryKey,
  commitSessionCheckpoint,
  createSessionMetadata,
  parseRecovery,
  parseRecoveryBaseline,
  parseSessionCheckpoint,
  readLatestSessionCheckpoint,
  recoveryBaselineKey,
  recoverySnapshotStorageValue,
  recoveryStorageKey,
  resolveRecoveryBaseline,
  SESSION_CHECKPOINT_SCHEMA_VERSION,
  type SessionMetadata,
} from "./session-storage";
import { openRecoveryDatabase, RECOVERY_STORE } from "./session-storage-idb";
import type { DirectoryEntry, EditorTab } from "../types";

const tab: EditorTab = {
  id: "tab-1",
  path: "/workspace/src/main.ts",
  name: "main.ts",
  content: "const value = 3;",
  savedContent: "const value = 0;",
  dirty: true,
  lineEnding: "lf",
  lineEndings: "cl",
  savedLineEndings: "lc",
  bom: false,
  savedBom: false,
  encoding: "UTF-8",
  language: "TypeScript",
  cursorLine: 1,
  cursorColumn: 1,
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
  children: [],
};

const dirtySession = (revision: number, savedRevision = revision - 1): SessionMetadata =>
  createSessionMetadata("/workspace", tab.id, [{ ...tab, revision, savedRevision, dirty: true }], root);

const v2Recovery = (revision: number, savedRevision = revision - 1) => parseRecovery({
  version: 2,
  tabId: tab.id,
  path: tab.path,
  revision,
  savedRevision,
  content: `const value = ${revision};`,
  savedContent: "",
  savedContentUnavailable: true,
  lineEnding: "lf",
  savedLineEndings: "lc",
  savedBom: false,
  encoding: "UTF-8",
})!;

const baseline = parseRecoveryBaseline({
  version: 1,
  tabId: tab.id,
  path: tab.path,
  savedRevision: 2,
  savedContent: "const value = 0;",
  savedLineEndings: "lc",
  savedBom: false,
  encoding: "UTF-8",
})!;

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

function disableIndexedDb() {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
}

async function readRawStore(key: string): Promise<unknown> {
  const database = await openRecoveryDatabase();
  if (!database) throw new Error("IndexedDB unavailable");
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(RECOVERY_STORE, "readonly");
    const request = transaction.objectStore(RECOVERY_STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Seeds a database exactly as the previous application version wrote it. */
async function seedLegacyCheckpoint(scope: string) {
  const database = await openRecoveryDatabase();
  if (!database) throw new Error("IndexedDB unavailable");
  const session = dirtySession(3, 2);
  const key = recoveryStorageKey(tab.id, scope);
  const legacyRecovery = {
    version: 1,
    tabId: tab.id,
    path: tab.path,
    revision: 3,
    content: "const value = 3;",
    savedContent: "const value = 0;",
    lineEnding: "lf",
  };
  const legacyCheckpoint = {
    version: 1,
    scope,
    checkpointId: `${scope}:1:legacy`,
    sequence: 1,
    committedAt: 100,
    session,
    recoveryRevisions: { [key]: 3 },
    recoveries: { [key]: legacyRecovery },
  };
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(["checkpoints", RECOVERY_STORE], "readwrite");
    transaction.objectStore("checkpoints").put({ checkpoint: legacyCheckpoint, recoveryKeys: [key], bytes: 0, updatedAt: 100 }, scope);
    transaction.objectStore(RECOVERY_STORE).put({ value: legacyRecovery, bytes: 1024, updatedAt: 100 }, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

beforeEach(async () => {
  await clearIndexedDb();
  storage.clear();
  fallbackLockTails = new Map();
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

describe("session schema migration", () => {
  it("reads a legacy v1 checkpoint JSON and normalizes it to the current version", () => {
    const session = dirtySession(3, 2);
    const key = recoveryStorageKey(tab.id, "legacy");
    const raw = JSON.stringify({
      version: 1,
      scope: "legacy",
      checkpointId: "legacy:1:a",
      sequence: 1,
      committedAt: 100,
      session,
      recoveryRevisions: { [key]: 3 },
      recoveries: {
        [key]: { version: 1, tabId: tab.id, path: tab.path, revision: 3, content: "const value = 3;", savedContent: "const value = 0;", lineEnding: "lf" },
      },
    });
    const checkpoint = parseSessionCheckpoint(raw);
    expect(checkpoint?.version).toBe(SESSION_CHECKPOINT_SCHEMA_VERSION);
    expect(checkpoint?.recoveries[key]).toMatchObject({ version: 1, savedContent: "const value = 0;" });
    expect(checkpoint?.recoveries[key]?.savedContentUnavailable).toBeUndefined();
  });

  it("reads legacy v1 recovery snapshots in both inline and unavailable forms", () => {
    const inline = parseRecovery({ version: 1, tabId: tab.id, path: tab.path, revision: 3, content: "a", savedContent: "b", lineEnding: "lf" });
    expect(inline).toMatchObject({ version: 1, savedContent: "b" });
    const unavailable = parseRecovery({ version: 1, tabId: tab.id, path: tab.path, revision: 3, content: "a", savedContent: "", savedContentUnavailable: true, lineEnding: "lf" });
    expect(unavailable).toMatchObject({ savedContent: "", savedContentUnavailable: true });
  });

  it("reads a legacy checkpoint stored in IndexedDB by the previous version", async () => {
    enableIndexedDb();
    await seedLegacyCheckpoint("legacy-scope");
    const restored = await readLatestSessionCheckpoint("legacy-scope");
    const key = recoveryStorageKey(tab.id, "legacy-scope");
    expect(restored?.version).toBe(SESSION_CHECKPOINT_SCHEMA_VERSION);
    expect(restored?.recoveries[key]).toMatchObject({ content: "const value = 3;", savedContent: "const value = 0;" });
  });

  it("resolves v2 baseline references only when the savedRevision matches", () => {
    const snapshot = v2Recovery(3, 2);
    expect(snapshot).toMatchObject({ version: 2, savedContentUnavailable: true, savedRevision: 2 });
    const resolved = resolveRecoveryBaseline(snapshot, baseline);
    expect(resolved).toMatchObject({ savedContent: "const value = 0;" });
    expect(resolved?.savedContentUnavailable).toBeUndefined();
    const stale = parseRecoveryBaseline({ version: 1, tabId: tab.id, path: tab.path, savedRevision: 1, savedContent: "old" })!;
    expect(resolveRecoveryBaseline(snapshot, stale)).toMatchObject({ savedContentUnavailable: true });
    expect(resolveRecoveryBaseline(snapshot, null)).toMatchObject({ savedContentUnavailable: true });
  });

  it("accepts self-contained fallback checkpoints with inline baselines", () => {
    const session = dirtySession(3, 2);
    const key = recoveryStorageKey(tab.id, "fallback-scope");
    const raw = JSON.stringify({
      version: SESSION_CHECKPOINT_SCHEMA_VERSION,
      scope: "fallback-scope",
      checkpointId: "fallback-scope:1:a",
      sequence: 1,
      committedAt: 100,
      session,
      recoveryRevisions: { [key]: 3 },
      recoveries: { [key]: { version: 2, tabId: tab.id, path: tab.path, revision: 3, savedRevision: 2, content: "const value = 3;", lineEnding: "lf" } },
      baselines: { [key]: { version: 1, tabId: tab.id, path: tab.path, savedRevision: 2, savedContent: "const value = 0;" } },
    });
    const checkpoint = parseSessionCheckpoint(raw);
    expect(checkpoint?.recoveries[key]).toMatchObject({ savedContent: "const value = 0;" });
    expect(checkpoint?.recoveries[key]?.savedContentUnavailable).toBeUndefined();
  });

  it("stores v2 snapshots without the inline baseline", () => {
    const resolved = resolveRecoveryBaseline(v2Recovery(3, 2), baseline)!;
    const stored = recoverySnapshotStorageValue(resolved);
    expect("savedContent" in stored).toBe(false);
    expect(stored).toMatchObject({ version: 2, savedRevision: 2 });
    const legacy = parseRecovery({ version: 1, tabId: tab.id, path: tab.path, revision: 3, content: "a", savedContent: "b", lineEnding: "lf" })!;
    expect(recoverySnapshotStorageValue(legacy)).toBe(legacy);
  });
});

describe("saved baseline durability", () => {
  it("writes the baseline once and retains it across later checkpoints", async () => {
    enableIndexedDb();
    const scope = "baseline-scope";
    const key = recoveryStorageKey(tab.id, scope);
    const first = await commitSessionCheckpoint({
      scope,
      session: dirtySession(3, 2),
      recoveries: [v2Recovery(3, 2)],
      baselines: [baseline],
      now: 100,
    });
    expect(first).toMatchObject({ ok: true, complete: true });

    // The stored snapshot is the compact v2 form; the baseline lives in its
    // own record.
    const storedRecord = await readRawStore(key) as { value: Record<string, unknown> };
    expect(storedRecord.value.version).toBe(2);
    expect("savedContent" in storedRecord.value).toBe(false);
    const baselineRecord = await readRawStore(recoveryBaselineKey(tab.id, scope)) as { value: Record<string, unknown> };
    expect(baselineRecord.value.savedContent).toBe("const value = 0;");

    // Reading resolves the baseline reference back into the snapshot.
    const restored = await readLatestSessionCheckpoint(scope);
    expect(restored?.recoveries[key]).toMatchObject({ savedContent: "const value = 0;" });
    expect(restored?.recoveries[key]?.savedContentUnavailable).toBeUndefined();

    // A later revision with an unchanged savedRevision does not resend the
    // baseline, and the stored one is still used.
    const second = await commitSessionCheckpoint({ scope, session: dirtySession(4, 2), recoveries: [v2Recovery(4, 2)], now: 200 });
    expect(second).toMatchObject({ ok: true, complete: true });
    const restoredAgain = await readLatestSessionCheckpoint(scope);
    expect(restoredAgain?.recoveries[key]).toMatchObject({ revision: 4, savedContent: "const value = 0;" });
    expect(await readRawStore(recoveryBaselineKey(tab.id, scope))).toBeTruthy();
  });

  it("keeps the fallback checkpoint self-contained with inline baselines", async () => {
    disableIndexedDb();
    const scope = "baseline-fallback";
    const result = await commitSessionCheckpoint({
      scope,
      session: dirtySession(3, 2),
      recoveries: [v2Recovery(3, 2)],
      baselines: [baseline],
      now: 100,
    });
    expect(result).toMatchObject({ ok: true, complete: true, durability: "fallback" });
    const key = recoveryStorageKey(tab.id, scope);
    const restored = await readLatestSessionCheckpoint(scope);
    expect(restored?.recoveries[key]).toMatchObject({ savedContent: "const value = 0;" });
    const raw = storage.getItem(`pude-session-checkpoint-v1:${scope}`);
    expect(raw).toContain("const value = 0;");
    expect(raw).toContain("baselines");
  });

  it("removes the baseline record together with the recovery entry once clean", async () => {
    enableIndexedDb();
    const scope = "baseline-clean";
    await commitSessionCheckpoint({
      scope,
      session: dirtySession(3, 2),
      recoveries: [v2Recovery(3, 2)],
      baselines: [baseline],
      now: 100,
    });
    const cleanSession = createSessionMetadata("/workspace", tab.id, [{ ...tab, revision: 4, savedRevision: 4, dirty: false }], root);
    const clean = await commitSessionCheckpoint({ scope, session: cleanSession, recoveryKeysToRemove: [recoveryStorageKey(tab.id, scope)], now: 200 });
    expect(clean).toMatchObject({ ok: true, complete: true });
    expect(await readRawStore(recoveryStorageKey(tab.id, scope))).toBeUndefined();
    expect(await readRawStore(recoveryBaselineKey(tab.id, scope))).toBeUndefined();
  });

  it("maps recovery keys to baseline keys and back", () => {
    const key = recoveryStorageKey(tab.id, "scope");
    const baselineKey = baselineKeyForRecoveryKey(key)!;
    expect(baselineKey).toBe(recoveryBaselineKey(tab.id, "scope"));
    expect(baselineKeyForRecoveryKey("pude-session-checkpoint-v1:x")).toBeNull();
  });
});
