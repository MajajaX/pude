import {
  baselineKeyForRecoveryKey,
  compactSessionWindows,
  emptySessionRegistry,
  isRecord,
  isRecoveryBaselineKey,
  isRecoveryStorageKey,
  makeSessionId,
  mergeSessionRegistries,
  nonNegativeInteger,
  nonNegativeTimestamp,
  parseRecovery,
  parseRecoveryBaseline,
  parseSessionCheckpoint,
  parseSessionCheckpointMetadata,
  parseSessionRegistry,
  recoveryBaselineSizeBytes,
  recoveryKeyForBaselineKey,
  recoverySnapshotSizeBytes,
  recoverySnapshotStorageValue,
  recoveryStorageKey,
  sameRecoveryScope,
  sameRecoveryStorageScope,
  sameSessionLease,
  sessionCheckpointStatus,
  updateRegistryForLease,
  utf8ByteLength,
  MAX_RECOVERY_TOTAL_BYTES,
  SESSION_REGISTRY_SCHEMA_VERSION,
  SESSION_REGISTRY_STORAGE_KEY,
  SESSION_WINDOW_LEASE_MS,
  type ClaimSessionWindowInput,
  type ClaimRecoverableSessionCandidateInput,
  type RecoveryBaseline,
  type RecoverySnapshot,
  type RecoveryStorageValue,
  type SessionCheckpoint,
  type SessionCheckpointMetadata,
  type SessionCheckpointMetadataReadResult,
  type SessionCheckpointReadResult,
  type SessionRegistry,
  type SessionRegistryResult,
  type SessionWindowLease,
  type SessionWindowRecord,
} from "./session-storage-schema";
import { readStorage } from "./session-storage-fallback";
import { notifyRecoveryDatabaseBlocked } from "./recovery-database-status";

export { setRecoveryDatabaseBlockedHandler } from "./recovery-database-status";
export type { RecoveryDatabaseBlockedHandler, RecoveryDatabaseOpenStatus } from "./recovery-database-status";

const RECOVERY_DB_NAME = "pude-recovery-v1";
const RECOVERY_DB_VERSION = 4;
export const RECOVERY_DATABASE_OPEN_TIMEOUT_MS = 8_000;
export const RECOVERY_STORE = "snapshots";
export const RECOVERY_METADATA_STORE = "metadata";
const RECOVERY_CHECKPOINT_STORE = "checkpoints";
const RECOVERY_REGISTRY_STORE = "registry";
const RECOVERY_REGISTRY_RECORD_KEY = "current";
const RECOVERY_METADATA_TOTAL_KEY = "__pude_recovery_total_v1__";

type StoredSessionRegistryRecord = {
  registry: SessionRegistry;
};

type StoredRecoveryRecord = {
  value: RecoveryStorageValue;
  bytes: number;
  updatedAt: number;
};

type RecoveryMetadataRecord = {
  bytes: number;
  updatedAt: number;
  kind?: "snapshot" | "baseline";
  tabId?: string;
  path?: string;
  revision?: number;
  savedRevision?: number;
};

type StoredSessionCheckpointRecord = {
  checkpoint: SessionCheckpointMetadata;
  recoveryKeys: string[];
  bytes: number;
  recoveryBytes?: number;
  updatedAt: number;
};

type DatabaseDiscardOutcome =
  | { status: "discarded" }
  | { status: "protected"; protectedKeys: string[] }
  | { status: "unavailable" };

let recoveryDatabasePromise: Promise<IDBDatabase | null> | undefined;

/** Drops the cached connection so the next operation reopens (and re-migrates) the database. */
export function invalidateRecoveryDatabase(): void {
  recoveryDatabasePromise = undefined;
}

export function openRecoveryDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (recoveryDatabasePromise) return recoveryDatabasePromise;
  let resolveOpen!: (database: IDBDatabase | null) => void;
  const pendingPromise = new Promise<IDBDatabase | null>((resolve) => { resolveOpen = resolve; });
  recoveryDatabasePromise = pendingPromise;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const finish = (database: IDBDatabase | null) => {
    if (timeout !== undefined) clearTimeout(timeout);
    if (settled) {
      database?.close();
      return;
    }
    settled = true;
    if (!database && recoveryDatabasePromise === pendingPromise) recoveryDatabasePromise = undefined;
    resolveOpen(database);
  };
  try {
    const request = indexedDB.open(RECOVERY_DB_NAME, RECOVERY_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RECOVERY_STORE)) database.createObjectStore(RECOVERY_STORE);
      if (!database.objectStoreNames.contains(RECOVERY_METADATA_STORE)) database.createObjectStore(RECOVERY_METADATA_STORE);
      const checkpointStore = database.objectStoreNames.contains(RECOVERY_CHECKPOINT_STORE)
        ? request.transaction?.objectStore(RECOVERY_CHECKPOINT_STORE)
        : database.createObjectStore(RECOVERY_CHECKPOINT_STORE);
      if (checkpointStore && !checkpointStore.indexNames.contains("workspace")) {
        checkpointStore.createIndex("workspace", "checkpoint.session.workspace", { unique: false });
      }
      if (!database.objectStoreNames.contains(RECOVERY_REGISTRY_STORE)) database.createObjectStore(RECOVERY_REGISTRY_STORE);
      const upgradeTransaction = request.transaction;
      if (!upgradeTransaction) return;
      const snapshotStore = upgradeTransaction.objectStore(RECOVERY_STORE);
      const metadataStore = upgradeTransaction.objectStore(RECOVERY_METADATA_STORE);
      let totalBytes = 0;
      const cursorRequest = snapshotStore.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          metadataStore.put({ bytes: totalBytes, updatedAt: Date.now() }, RECOVERY_METADATA_TOTAL_KEY);
          return;
        }
        if (typeof cursor.key === "string") {
          // Baseline records live in the same store but are not recovery
          // snapshots; keep them (and their metadata) across upgrades.
          if (isRecoveryBaselineKey(cursor.key)) {
            const baseline = readStoredBaselineRecord(cursor.value);
            if (baseline) {
              const metadata = { bytes: baseline.bytes, updatedAt: baseline.updatedAt, kind: "baseline" as const, tabId: baseline.value.tabId, path: baseline.value.path, savedRevision: baseline.value.savedRevision } satisfies RecoveryMetadataRecord;
              metadataStore.put(metadata, cursor.key);
              totalBytes += metadata.bytes;
            }
            else snapshotStore.delete(cursor.key);
          } else {
            const record = readStoredRecoveryRecord(cursor.value);
            if (record) {
              const snapshot = parseRecovery(record.value);
              if (snapshot) {
                const metadata = { bytes: record.bytes, updatedAt: record.updatedAt, kind: "snapshot" as const, tabId: snapshot.tabId, path: snapshot.path, revision: snapshot.revision } satisfies RecoveryMetadataRecord;
                metadataStore.put(metadata, cursor.key);
                totalBytes += metadata.bytes;
              }
            }
            else snapshotStore.delete(cursor.key);
          }
        }
        cursor.continue();
      };
      cursorRequest.onerror = () => {
        try { upgradeTransaction.abort(); } catch { /* A failed request can be reported after its transaction has finished. */ }
      };
    };
    timeout = setTimeout(() => {
      notifyRecoveryDatabaseBlocked(RECOVERY_DATABASE_OPEN_TIMEOUT_MS, "timed-out");
      finish(null);
    }, RECOVERY_DATABASE_OPEN_TIMEOUT_MS);
    request.onblocked = () => {
      notifyRecoveryDatabaseBlocked(RECOVERY_DATABASE_OPEN_TIMEOUT_MS, "blocked");
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        recoveryDatabasePromise = undefined;
      };
      finish(database);
    };
    request.onerror = () => finish(null);
  } catch {
    finish(null);
  }
  return pendingPromise;
}

export function writeRecoveryDatabase(
  database: IDBDatabase,
  key: string,
  snapshot: RecoverySnapshot,
  bytes: number,
  maxBytes = MAX_RECOVERY_TOTAL_BYTES,
  protectedRecoveryKeys: Set<string> = new Set(),
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (saved: boolean) => {
      if (settled) return;
      settled = true;
      resolve(saved);
    };
    try {
      const transaction = database.transaction([RECOVERY_STORE, RECOVERY_METADATA_STORE], "readwrite");
      const store = transaction.objectStore(RECOVERY_STORE);
      const metadataStore = transaction.objectStore(RECOVERY_METADATA_STORE);
      const existingRequest = metadataStore.get(key);
      const totalRequest = metadataStore.get(RECOVERY_METADATA_TOTAL_KEY);
      existingRequest.onerror = totalRequest.onerror = () => { transaction.abort(); };
      existingRequest.onsuccess = () => {
        const existing = readRecoveryMetadataRecord(existingRequest.result);
        totalRequest.onsuccess = () => {
          const totalRecord = readRecoveryMetadataRecord(totalRequest.result);
          const records: Array<{ key: string; bytes: number; updatedAt: number }> = [];
          const startWrite = (totalBytes: number) => {
            let projectedBytes = totalBytes - (existing?.bytes ?? 0) + bytes;
            const write = (evicted: typeof records, finalProjectedBytes = projectedBytes) => {
              if (finalProjectedBytes > maxBytes) {
                transaction.abort();
                return;
              }
              for (const candidate of evicted) {
                store.delete(candidate.key);
                metadataStore.delete(candidate.key);
              }
              const updatedAt = Date.now();
              const parsed = parseRecovery(snapshot);
              if (!parsed) {
                transaction.abort();
                return;
              }
              store.put({ value: recoverySnapshotStorageValue(parsed), bytes, updatedAt } satisfies StoredRecoveryRecord, key);
              metadataStore.put({ bytes, updatedAt, kind: "snapshot", tabId: parsed.tabId, path: parsed.path, revision: parsed.revision } satisfies RecoveryMetadataRecord, key);
              metadataStore.put({ bytes: finalProjectedBytes, updatedAt }, RECOVERY_METADATA_TOTAL_KEY);
            };
            if (projectedBytes <= maxBytes) {
              write([]);
              return;
            }
            const cursorRequest = metadataStore.openCursor();
            cursorRequest.onerror = () => { transaction.abort(); };
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) {
                const candidates = records
                  .filter((record) => {
                    if (record.key === key || protectedRecoveryKeys.has(record.key)) return false;
                    if (!isRecoveryBaselineKey(record.key)) return true;
                    const recoveryKey = recoveryKeyForBaselineKey(record.key);
                    return !recoveryKey || !protectedRecoveryKeys.has(recoveryKey);
                  })
                  .sort((left, right) => left.updatedAt - right.updatedAt);
                const evicted: typeof records = [];
                for (const candidate of candidates) {
                  if (projectedBytes <= maxBytes) break;
                  evicted.push(candidate);
                  projectedBytes -= candidate.bytes;
                }
                if (projectedBytes > maxBytes) {
                  transaction.abort();
                  return;
                }
                write(evicted, projectedBytes);
                return;
              }
              if (typeof cursor.key === "string" && cursor.key !== RECOVERY_METADATA_TOTAL_KEY && (isRecoveryStorageKey(cursor.key) || isRecoveryBaselineKey(cursor.key))) {
                const record = readRecoveryMetadataRecord(cursor.value);
                if (record) records.push({ key: cursor.key, bytes: record.bytes, updatedAt: record.updatedAt });
              }
              cursor.continue();
            };
          };
          if (totalRecord) {
            startWrite(totalRecord.bytes);
            return;
          }
          // Compatibility for databases seeded by an older build without the
          // aggregate usage record. This is a one-time metadata-only scan.
          const cursorRequest = metadataStore.openCursor();
          let totalBytes = 0;
          cursorRequest.onerror = () => { transaction.abort(); };
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              metadataStore.put({ bytes: totalBytes, updatedAt: Date.now() }, RECOVERY_METADATA_TOTAL_KEY);
              startWrite(totalBytes);
              return;
            }
            if (typeof cursor.key === "string" && cursor.key !== RECOVERY_METADATA_TOTAL_KEY) {
              totalBytes += readRecoveryMetadataRecord(cursor.value)?.bytes ?? 0;
            }
            cursor.continue();
          };
        };
      };
      transaction.oncomplete = () => finish(true);
      transaction.onerror = () => finish(false);
      transaction.onabort = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

export function readRecoveryMetadataBytes(database: IDBDatabase): Promise<number> {
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(RECOVERY_METADATA_STORE, "readonly");
      const request = transaction.objectStore(RECOVERY_METADATA_STORE).get(RECOVERY_METADATA_TOTAL_KEY);
      let total = 0;
      let missingTotal = false;
      request.onsuccess = () => {
        const record = readRecoveryMetadataRecord(request.result);
        if (record) total = record.bytes;
        else missingTotal = true;
      };
      request.onerror = () => { missingTotal = true; };
      transaction.oncomplete = () => {
        if (!missingTotal) return resolve(total);
        try {
          const scan = database.transaction(RECOVERY_METADATA_STORE, "readonly");
          const cursor = scan.objectStore(RECOVERY_METADATA_STORE).openCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (!item) return;
            if (item.key !== RECOVERY_METADATA_TOTAL_KEY) total += readRecoveryMetadataRecord(item.value)?.bytes ?? 0;
            item.continue();
          };
          scan.oncomplete = () => resolve(total);
          scan.onerror = scan.onabort = () => resolve(total);
        } catch {
          resolve(total);
        }
      };
      transaction.onerror = transaction.onabort = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
}

export function readStoredRecoveryValue(value: unknown): RecoveryStorageValue | null {
  const record = readStoredRecoveryRecord(value);
  return record?.value ?? null;
}

export function selectRecoveryValue(databaseValue: RecoveryStorageValue | null, fallbackValue: string | null): RecoveryStorageValue | null {
  if (!databaseValue) return fallbackValue;
  if (!fallbackValue) return databaseValue;
  const databaseSnapshot = parseRecovery(databaseValue);
  const fallbackSnapshot = parseRecovery(fallbackValue);
  if (databaseSnapshot && fallbackSnapshot && fallbackSnapshot.revision >= databaseSnapshot.revision) return fallbackSnapshot;
  return databaseValue;
}

function readRecoveryMetadataRecord(value: unknown): RecoveryMetadataRecord | null {
  if (!isRecord(value)) return null;
  const bytes = nonNegativeInteger(value.bytes);
  const updatedAt = nonNegativeTimestamp(value.updatedAt);
  if (bytes === undefined || updatedAt === undefined) return null;
  return {
    bytes,
    updatedAt,
    ...(value.kind === "snapshot" || value.kind === "baseline" ? { kind: value.kind } : {}),
    ...(typeof value.tabId === "string" ? { tabId: value.tabId } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(nonNegativeInteger(value.revision) !== undefined ? { revision: nonNegativeInteger(value.revision) } : {}),
    ...(nonNegativeInteger(value.savedRevision) !== undefined ? { savedRevision: nonNegativeInteger(value.savedRevision) } : {}),
  };
}

function readStoredRecoveryRecord(value: unknown): StoredRecoveryRecord | null {
  if (typeof value === "string") {
    const snapshot = parseRecovery(value);
    return snapshot ? { value, bytes: recoverySnapshotSizeBytes(snapshot), updatedAt: 0 } : null;
  }
  if (!isRecord(value)) return null;
  const candidate = "value" in value ? value.value : value;
  const snapshot = parseRecovery(candidate);
  if (!snapshot) return null;
  const bytes = nonNegativeInteger(value.bytes) ?? recoverySnapshotSizeBytes(snapshot);
  const updatedAt = nonNegativeTimestamp(value.updatedAt) ?? 0;
  return { value: snapshot, bytes, updatedAt };
}

/** Reads a baseline record ({value, bytes, updatedAt} or a bare baseline). */
function readStoredBaselineRecord(value: unknown): { value: RecoveryBaseline; bytes: number; updatedAt: number } | null {
  if (!isRecord(value)) return null;
  const candidate = "value" in value ? value.value : value;
  const baseline = parseRecoveryBaseline(candidate);
  if (!baseline) return null;
  const bytes = nonNegativeInteger(value.bytes) ?? recoveryBaselineSizeBytes(baseline);
  const updatedAt = nonNegativeTimestamp(value.updatedAt) ?? 0;
  return { value: baseline, bytes, updatedAt };
}

export function readSessionCheckpointDatabase(database: IDBDatabase, scope: string): Promise<SessionCheckpointReadResult | null> {
  return new Promise((resolve, reject) => {
    let marker: unknown;
    let markerKeys: string[] = [];
    let failed = false;
    const recoveries: Record<string, RecoverySnapshot> = {};
    const baselines: Record<string, RecoveryBaseline> = {};
    try {
      const transaction = database.transaction([RECOVERY_CHECKPOINT_STORE, RECOVERY_STORE], "readonly");
      const markerRequest = transaction.objectStore(RECOVERY_CHECKPOINT_STORE).get(scope);
      markerRequest.onerror = () => { failed = true; };
      markerRequest.onsuccess = () => {
        const raw = markerRequest.result;
        if (!isRecord(raw) || !isRecord(raw.checkpoint)) {
          if (raw !== undefined) failed = true;
          return;
        }
        marker = raw.checkpoint;
        if (Array.isArray(raw.recoveryKeys)) markerKeys = raw.recoveryKeys.filter((key): key is string => typeof key === "string");
        const keys = markerKeys.length ? markerKeys : Object.keys(isRecord(raw.checkpoint.recoveries) ? raw.checkpoint.recoveries : {});
        const store = transaction.objectStore(RECOVERY_STORE);
        for (const key of keys) {
          const request = store.get(key);
          request.onerror = () => { failed = true; };
          request.onsuccess = () => {
            const snapshot = parseRecovery(readStoredRecoveryValue(request.result));
            if (snapshot) recoveries[key] = snapshot;
            else failed = true;
          };
          const baselineKey = baselineKeyForRecoveryKey(key);
          if (!baselineKey) continue;
          const baselineRequest = store.get(baselineKey);
          baselineRequest.onerror = () => { failed = true; };
          baselineRequest.onsuccess = () => {
            const baseline = readStoredBaselineRecord(baselineRequest.result);
            if (baseline) baselines[key] = baseline.value;
            else if (baselineRequest.result !== undefined) failed = true;
          };
        }
      };
      transaction.oncomplete = () => {
        if (failed) return reject(transaction.error ?? new Error("IndexedDB checkpoint read failed."));
        if (!marker) return resolve(null);
        const candidate = parseSessionCheckpoint({ ...((marker as Record<string, unknown>)), recoveries }, baselines);
        if (!candidate || candidate.scope !== scope) return reject(new Error("IndexedDB checkpoint body is invalid or incomplete."));
        resolve(sessionCheckpointStatus(candidate, "indexeddb"));
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB checkpoint transaction failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB checkpoint transaction was aborted."));
    } catch {
      reject(new Error("IndexedDB checkpoint transaction could not be opened."));
    }
  });
}

export function readSessionCheckpointMetadataDatabase(database: IDBDatabase, scope: string): Promise<SessionCheckpointMetadataReadResult | null> {
  return new Promise((resolve, reject) => {
    try {
      const transaction = database.transaction([RECOVERY_CHECKPOINT_STORE, RECOVERY_METADATA_STORE], "readonly");
      const checkpointStore = transaction.objectStore(RECOVERY_CHECKPOINT_STORE);
      const metadataStore = transaction.objectStore(RECOVERY_METADATA_STORE);
      const request = checkpointStore.get(scope);
      let result: SessionCheckpointMetadataReadResult | null = null;
      let pending = 0;
      const missing = new Set<string>();
      let failed = false;
      request.onsuccess = () => {
        const stored = request.result;
        if (isRecord(stored) && isRecord(stored.checkpoint)) {
          result = parseSessionCheckpointMetadata(stored.checkpoint, Array.isArray(stored.recoveryKeys) ? stored.recoveryKeys : undefined, "indexeddb");
          if (!result) failed = true;
          if (result) {
            pending = result.checkpoint.session.tabs.filter((tab) => tab.dirty).length;
            result.missingRecoveryKeys.forEach((key) => missing.add(key));
            if (!pending) return;
            for (const tab of result.checkpoint.session.tabs.filter((candidate) => candidate.dirty)) {
              const key = recoveryStorageKey(tab.id, scope);
              const metaRequest = metadataStore.get(key);
              metaRequest.onerror = () => { failed = true; missing.add(key); pending -= 1; };
              metaRequest.onsuccess = () => {
                const meta = readRecoveryMetadataRecord(metaRequest.result);
                if (!meta || meta.kind !== "snapshot" || meta.tabId !== tab.id || meta.path !== tab.path || meta.revision !== tab.revision) missing.add(key);
                if (metaRequest.result !== undefined && !meta) failed = true;
                pending -= 1;
              };
            }
          }
        } else if (stored !== undefined) {
          failed = true;
        }
      };
      request.onerror = () => { failed = true; };
      transaction.oncomplete = () => {
        if (failed) return reject(transaction.error ?? new Error("IndexedDB checkpoint metadata read failed."));
        resolve(result ? { ...result, completeMetadata: result.completeMetadata && missing.size === 0, missingRecoveryKeys: [...new Set([...result.missingRecoveryKeys, ...missing])] } : null);
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB checkpoint metadata transaction failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB checkpoint metadata transaction was aborted."));
    } catch {
      reject(new Error("IndexedDB checkpoint metadata transaction could not be opened."));
    }
  });
}

/** Returns a checkpoint's stored snapshot/baseline byte budget without reading bodies. */
export function readCheckpointRecoveryBytes(database: IDBDatabase, scope: string): Promise<number | null> {
  return new Promise((resolve) => {
    let total = 0;
    let pending = 0;
    let missing = false;
    try {
      const transaction = database.transaction([RECOVERY_CHECKPOINT_STORE, RECOVERY_METADATA_STORE], "readonly");
      const checkpointRequest = transaction.objectStore(RECOVERY_CHECKPOINT_STORE).get(scope);
      const metadata = transaction.objectStore(RECOVERY_METADATA_STORE);
      checkpointRequest.onerror = () => { missing = true; };
      checkpointRequest.onsuccess = () => {
        const stored = checkpointRequest.result;
        if (!isRecord(stored) || !isRecord(stored.checkpoint)) return;
        const direct = nonNegativeInteger(stored.recoveryBytes);
        if (direct !== undefined) {
          total = direct;
          return;
        }
        const rawKeys = Array.isArray(stored.recoveryKeys)
          ? stored.recoveryKeys
          : isRecord(stored.checkpoint.recoveryRevisions) ? Object.keys(stored.checkpoint.recoveryRevisions) : [];
        const keys = rawKeys.filter((key): key is string => typeof key === "string" && isRecoveryStorageKey(key));
        pending = keys.length * 2;
        if (!pending) return;
        for (const key of keys) {
          const baselineKey = baselineKeyForRecoveryKey(key);
          for (const candidateKey of baselineKey ? [key, baselineKey] : [key]) {
            const request = metadata.get(candidateKey);
            request.onerror = () => { missing = true; pending -= 1; };
            request.onsuccess = () => {
              const record = readRecoveryMetadataRecord(request.result);
              if (record) total += record.bytes;
              else if (candidateKey === key) missing = true;
              pending -= 1;
            };
          }
          if (!baselineKey) pending -= 1;
        }
      };
      transaction.oncomplete = () => resolve(missing && total === 0 ? null : total);
      transaction.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Workspace-scoped metadata query; this never opens the snapshots store. */
export function readSessionCheckpointCandidatesDatabase(database: IDBDatabase, workspace?: string): Promise<SessionCheckpointMetadataReadResult[]> {
  return new Promise((resolve) => {
    const results: SessionCheckpointMetadataReadResult[] = [];
    let failed = false;
    try {
      const transaction = database.transaction([RECOVERY_CHECKPOINT_STORE, RECOVERY_METADATA_STORE], "readonly");
      const checkpointStore = transaction.objectStore(RECOVERY_CHECKPOINT_STORE);
      const metadataStore = transaction.objectStore(RECOVERY_METADATA_STORE);
      const source = workspace === undefined ? checkpointStore : checkpointStore.index("workspace");
      const request = workspace === undefined ? source.openCursor() : source.openCursor(IDBKeyRange.only(workspace));
      request.onerror = () => { failed = true; };
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const stored = cursor.value;
        if (isRecord(stored) && isRecord(stored.checkpoint)) {
          const candidate = parseSessionCheckpointMetadata(stored.checkpoint, Array.isArray(stored.recoveryKeys) ? stored.recoveryKeys : undefined, "indexeddb");
          if (candidate) {
            const pending = new Set(candidate.missingRecoveryKeys);
            const expected = candidate.checkpoint.session.tabs.filter((tab) => tab.dirty);
            let remaining = expected.length;
            const finishCandidate = () => {
              if (remaining > 0) return;
              results.push({ ...candidate, completeMetadata: pending.size === 0, missingRecoveryKeys: [...pending] });
            };
            if (!remaining) finishCandidate();
            for (const tab of expected) {
              const key = recoveryStorageKey(tab.id, candidate.checkpoint.scope);
              const metaRequest = metadataStore.get(key);
              metaRequest.onerror = () => { failed = true; pending.add(key); remaining -= 1; finishCandidate(); };
              metaRequest.onsuccess = () => {
                const record = readRecoveryMetadataRecord(metaRequest.result);
                if (!record || record.kind !== "snapshot" || record.tabId !== tab.id || record.path !== tab.path || record.revision !== tab.revision) pending.add(key);
                remaining -= 1;
                finishCandidate();
              };
            }
          }
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(failed ? results : results);
      transaction.onerror = () => resolve([]);
      transaction.onabort = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export function readAllSessionCheckpointsDatabase(database: IDBDatabase): Promise<SessionCheckpointReadResult[]> {
  return new Promise((resolve) => {
    const markers: Array<{ marker: Record<string, unknown>; keys: string[]; recoveries: Record<string, RecoverySnapshot>; baselines: Record<string, RecoveryBaseline> }> = [];
    let failed = false;
    try {
      const transaction = database.transaction([RECOVERY_CHECKPOINT_STORE, RECOVERY_STORE], "readonly");
      const checkpointStore = transaction.objectStore(RECOVERY_CHECKPOINT_STORE);
      const snapshotStore = transaction.objectStore(RECOVERY_STORE);
      const cursorRequest = checkpointStore.openCursor();
      cursorRequest.onerror = () => { failed = true; };
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (isRecord(cursor.value) && isRecord(cursor.value.checkpoint)) {
          const marker = cursor.value.checkpoint;
          const keys = Array.isArray(cursor.value.recoveryKeys)
            ? cursor.value.recoveryKeys.filter((key): key is string => isRecoveryStorageKey(key))
            : [];
          const item = { marker, keys, recoveries: {} as Record<string, RecoverySnapshot>, baselines: {} as Record<string, RecoveryBaseline> };
          markers.push(item);
          for (const key of keys) {
            const request = snapshotStore.get(key);
            request.onerror = () => { failed = true; };
            request.onsuccess = () => {
              const snapshot = parseRecovery(readStoredRecoveryValue(request.result));
              if (snapshot) item.recoveries[key] = snapshot;
              else failed = true;
            };
            const baselineKey = baselineKeyForRecoveryKey(key);
            if (!baselineKey) continue;
            const baselineRequest = snapshotStore.get(baselineKey);
            baselineRequest.onerror = () => undefined;
            baselineRequest.onsuccess = () => {
              const baseline = readStoredBaselineRecord(baselineRequest.result);
              if (baseline) item.baselines[key] = baseline.value;
            };
          }
        }
        cursor.continue();
      };
      transaction.oncomplete = () => {
        if (failed) return resolve([]);
        const results: SessionCheckpointReadResult[] = [];
        for (const item of markers) {
          const checkpoint = parseSessionCheckpoint({ ...item.marker, recoveries: item.recoveries }, item.baselines);
          if (checkpoint) results.push(sessionCheckpointStatus(checkpoint, "indexeddb"));
        }
        resolve(results);
      };
      transaction.onerror = () => resolve([]);
      transaction.onabort = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export function writeSessionCheckpointDatabase(
  database: IDBDatabase,
  checkpoint: SessionCheckpointMetadata,
  changedRecoveries: Record<string, RecoverySnapshot>,
  baselines: Record<string, RecoveryBaseline>,
  protectedRecoveryKeys: Set<string>,
  maxBytes: number,
  lease?: SessionWindowLease,
): Promise<{ saved: boolean; skipped: boolean; evictedKeys: string[] }> {
  return new Promise((resolve) => {
    let settled = false;
    let checkpointLoaded = false;
    let existingCheckpoint: StoredSessionCheckpointRecord | undefined;
    let registryLoaded = false;
    let usageLoaded = false;
    let pendingMetadataReads = 0;
    let previousRegistry: SessionRegistry | null = null;
    let projectedBytes = 0;
    let evictedKeys: string[] = [];
    const records: Array<{ key: string; bytes: number; updatedAt: number }> = [];
    const finish = (saved: boolean, skipped: boolean, evictedKeys: string[] = []) => {
      if (settled) return;
      settled = true;
      resolve({ saved, skipped, evictedKeys });
    };
    try {
      const transaction = database.transaction([RECOVERY_STORE, RECOVERY_METADATA_STORE, RECOVERY_CHECKPOINT_STORE, RECOVERY_REGISTRY_STORE], "readwrite");
      const checkpointStore = transaction.objectStore(RECOVERY_CHECKPOINT_STORE);
      const registryStore = transaction.objectStore(RECOVERY_REGISTRY_STORE);
      const metadataStore = transaction.objectStore(RECOVERY_METADATA_STORE);
      const checkpointRequest = checkpointStore.get(checkpoint.scope);
      checkpointRequest.onerror = () => { transaction.abort(); };
      checkpointRequest.onsuccess = () => {
        const existing = checkpointRequest.result;
        if (isRecord(existing) && isRecord(existing.checkpoint)) {
          const parsed = parseSessionCheckpointMetadata(existing.checkpoint, Array.isArray(existing.recoveryKeys) ? existing.recoveryKeys : undefined, "indexeddb");
          if (parsed) existingCheckpoint = { checkpoint: parsed.checkpoint, recoveryKeys: parsed.checkpoint.recoveryKeys, bytes: nonNegativeInteger(existing.bytes) ?? 0, recoveryBytes: nonNegativeInteger(existing.recoveryBytes), updatedAt: nonNegativeTimestamp(existing.updatedAt) ?? 0 };
        }
        checkpointLoaded = true;
        prepareMetadataReads();
      };
      const registryRequest = registryStore.get(RECOVERY_REGISTRY_RECORD_KEY);
      registryRequest.onerror = () => { transaction.abort(); };
      registryRequest.onsuccess = () => {
        const candidate = readStoredSessionRegistry(registryRequest.result);
        previousRegistry = candidate;
        registryLoaded = true;
        maybeCommit();
      };
      const totalRequest = metadataStore.get(RECOVERY_METADATA_TOTAL_KEY);
      totalRequest.onerror = () => { transaction.abort(); };
      totalRequest.onsuccess = () => {
        projectedBytes = readRecoveryMetadataRecord(totalRequest.result)?.bytes ?? 0;
        usageLoaded = true;
        prepareMetadataReads();
      };
      transaction.oncomplete = () => finish(true, false, evictedKeys);
      transaction.onerror = () => finish(false, false);
      transaction.onabort = () => finish(false, true);

      function prepareMetadataReads() {
        if (!checkpointLoaded || !usageLoaded || settled) return;
        const changedKeys = new Set(Object.keys(changedRecoveries));
        const desired = new Set(checkpoint.recoveryKeys);
        const tabs = new Map(checkpoint.session.tabs.map((tab) => [recoveryStorageKey(tab.id, checkpoint.scope), tab]));
        const requiredReads = new Set<string>();
        for (const key of desired) if (!changedKeys.has(key)) requiredReads.add(key);
        for (const baselineKey of Object.keys(baselines)) requiredReads.add(baselineKey);
        const oldKeys = existingCheckpoint?.recoveryKeys ?? [];
        for (const key of oldKeys) if (!desired.has(key)) requiredReads.add(key);
        for (const key of [...desired, ...oldKeys]) {
          const baselineKey = baselineKeyForRecoveryKey(key);
          if (baselineKey) requiredReads.add(baselineKey);
        }
        for (const key of changedKeys) requiredReads.add(key);
        pendingMetadataReads = requiredReads.size;
        if (!pendingMetadataReads) {
          maybeCommit();
          return;
        }
        for (const key of requiredReads) {
          const request = metadataStore.get(key);
          request.onerror = () => { transaction.abort(); };
          request.onsuccess = () => {
            const record = readRecoveryMetadataRecord(request.result);
            if (record) records.push({ key, bytes: record.bytes, updatedAt: record.updatedAt });
            if (desired.has(key) && !changedKeys.has(key)) {
              const tab = tabs.get(key);
              if (!tab || !record || record.kind !== "snapshot" || record.tabId !== tab.id || record.path !== tab.path || record.revision !== tab.revision) {
                transaction.abort();
                return;
              }
            }
            pendingMetadataReads -= 1;
            maybeCommit();
          };
        }
      }

      function maybeCommit() {
        if (!checkpointLoaded || !registryLoaded || !usageLoaded || pendingMetadataReads > 0 || settled) return;
        if (existingCheckpoint && existingCheckpoint.checkpoint.sequence >= checkpoint.sequence) {
          transaction.abort();
          return;
        }
        const liveOwner = previousRegistry?.windows.find((entry) => entry.scope === checkpoint.scope && entry.status === "open");
        if (liveOwner && (!lease || !sameSessionLease(liveOwner, lease))) {
          transaction.abort();
          return;
        }
        if (lease && !previousRegistry) {
          transaction.abort();
          return;
        }

        const changed = Object.entries(changedRecoveries);
        const changedBytes = changed.reduce((total, [, snapshot]) => total + recoverySnapshotSizeBytes(snapshot), 0);
        const changedExistingBytes = changed.reduce((total, [key]) => total + (records.find((record) => record.key === key)?.bytes ?? 0), 0);
        const desired = new Set(checkpoint.recoveryKeys);
        const oldKeys = existingCheckpoint?.recoveryKeys ?? [];
        const removedKeys = oldKeys.filter((key) => !desired.has(key));
        const removedBytes = removedKeys.reduce((total, key) => {
          const baselineKey = baselineKeyForRecoveryKey(key);
          return total + (records.find((record) => record.key === key)?.bytes ?? 0) + (baselineKey ? records.find((record) => record.key === baselineKey)?.bytes ?? 0 : 0);
        }, 0);
        const changedBaselines = Object.entries(baselines);
        const removedStorageKeys = new Set(removedKeys.flatMap((key) => [key, baselineKeyForRecoveryKey(key)].filter((candidate): candidate is string => Boolean(candidate))));
        const changedBaselineKeys = new Set(changedBaselines.map(([key]) => key));
        const baselineBytes = changedBaselines.reduce((total, [, baseline]) => total + recoveryBaselineSizeBytes(baseline), 0);
        const changedBaselineOldBytes = changedBaselines.reduce((total, [key]) => total + (records.find((record) => record.key === key)?.bytes ?? 0), 0);
        projectedBytes = projectedBytes - changedExistingBytes - removedBytes - changedBaselineOldBytes + changedBytes + baselineBytes;

        const applyWrites = (evicted: Array<{ key: string; bytes: number; updatedAt: number }>, finalBytes: number) => {
          if (finalBytes > maxBytes) {
            transaction.abort();
            return;
          }
          const snapshotStore = transaction.objectStore(RECOVERY_STORE);
          for (const record of evicted) {
            snapshotStore.delete(record.key);
            metadataStore.delete(record.key);
          }
          for (const key of removedKeys) {
            snapshotStore.delete(key);
            metadataStore.delete(key);
            const baselineKey = baselineKeyForRecoveryKey(key);
            if (baselineKey) {
              snapshotStore.delete(baselineKey);
              metadataStore.delete(baselineKey);
            }
          }
          const updatedAt = checkpoint.committedAt;
          for (const [key, snapshot] of changed) {
            const bytes = recoverySnapshotSizeBytes(snapshot);
            const parsed = parseRecovery(snapshot);
            if (!parsed) { transaction.abort(); return; }
            snapshotStore.put({ value: recoverySnapshotStorageValue(parsed), bytes, updatedAt } satisfies StoredRecoveryRecord, key);
            metadataStore.put({ bytes, updatedAt, kind: "snapshot", tabId: parsed.tabId, path: parsed.path, revision: parsed.revision } satisfies RecoveryMetadataRecord, key);
          }
          for (const [baselineKey, baseline] of changedBaselines) {
            const bytes = recoveryBaselineSizeBytes(baseline);
            snapshotStore.put({ value: baseline, bytes, updatedAt } satisfies { value: unknown; bytes: number; updatedAt: number }, baselineKey);
            metadataStore.put({ bytes, updatedAt, kind: "baseline", tabId: baseline.tabId, path: baseline.path, savedRevision: baseline.savedRevision } satisfies RecoveryMetadataRecord, baselineKey);
          }
          metadataStore.put({ bytes: finalBytes, updatedAt }, RECOVERY_METADATA_TOTAL_KEY);
          const recoveryBytes = checkpoint.recoveryKeys.reduce((total, key) => {
            const baselineKey = baselineKeyForRecoveryKey(key);
            const snapshotBytes = changedRecoveries[key]
              ? recoverySnapshotSizeBytes(changedRecoveries[key])
              : records.find((record) => record.key === key)?.bytes ?? 0;
            const baselineBytes = baselineKey
              ? (baselines[baselineKey] ? recoveryBaselineSizeBytes(baselines[baselineKey]) : records.find((record) => record.key === baselineKey)?.bytes ?? 0)
              : 0;
            return total + snapshotBytes + baselineBytes;
          }, 0);
          checkpointStore.put({ checkpoint, recoveryKeys: checkpoint.recoveryKeys, bytes: utf8ByteLength(JSON.stringify(checkpoint)), recoveryBytes, updatedAt } satisfies StoredSessionCheckpointRecord, checkpoint.scope);
          if (lease) {
            const nextRegistry = previousRegistry && updateRegistryForLease(previousRegistry, lease, checkpoint.recoveryKeys, updatedAt);
            if (!nextRegistry) { transaction.abort(); return; }
            registryStore.put({ registry: nextRegistry } satisfies StoredSessionRegistryRecord, RECOVERY_REGISTRY_RECORD_KEY);
          }
          evictedKeys = evicted.map((record) => record.key);
        };

        if (projectedBytes <= maxBytes) {
          applyWrites([], projectedBytes);
          return;
        }
        const cursorRequest = metadataStore.openCursor();
        cursorRequest.onerror = () => { transaction.abort(); };
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            const candidates = records
              .filter((record) => {
                if (desired.has(record.key) || removedStorageKeys.has(record.key) || changedBaselineKeys.has(record.key) || protectedRecoveryKeys.has(record.key)) return false;
                if (!isRecoveryBaselineKey(record.key)) return true;
                const recoveryKey = recoveryKeyForBaselineKey(record.key);
                return !recoveryKey || (!desired.has(recoveryKey) && !protectedRecoveryKeys.has(recoveryKey));
              })
              .sort((left, right) => left.updatedAt - right.updatedAt);
            const evicted: typeof records = [];
            let finalBytes = projectedBytes;
            for (const candidate of candidates) {
              if (finalBytes <= maxBytes) break;
              evicted.push(candidate);
              finalBytes -= candidate.bytes;
            }
            applyWrites(evicted, finalBytes);
            return;
          }
          if (typeof cursor.key === "string" && cursor.key !== RECOVERY_METADATA_TOTAL_KEY && (isRecoveryStorageKey(cursor.key) || isRecoveryBaselineKey(cursor.key))) {
            const record = readRecoveryMetadataRecord(cursor.value);
            if (record && !records.some((candidate) => candidate.key === cursor.key)) records.push({ key: cursor.key, bytes: record.bytes, updatedAt: record.updatedAt });
          }
          cursor.continue();
        };
      }
    } catch {
      finish(false, false);
    }
  });
}

export function discardSessionCheckpointDatabase(database: IDBDatabase, scope: string, removedKeys: Set<string>): Promise<DatabaseDiscardOutcome> {
  return new Promise((resolve) => {
    let outcome: DatabaseDiscardOutcome | undefined;
    try {
      const transaction = database.transaction([RECOVERY_REGISTRY_STORE, RECOVERY_CHECKPOINT_STORE, RECOVERY_STORE, RECOVERY_METADATA_STORE], "readwrite");
      const registryRequest = transaction.objectStore(RECOVERY_REGISTRY_STORE).get(RECOVERY_REGISTRY_RECORD_KEY);
      registryRequest.onerror = () => { transaction.abort(); };
      registryRequest.onsuccess = () => {
        const fallbackRegistry = parseSessionRegistry(readStorage(SESSION_REGISTRY_STORAGE_KEY));
        const databaseRegistry = readStoredSessionRegistry(registryRequest.result) ?? emptySessionRegistry();
        const registry = fallbackRegistry ? mergeSessionRegistries(databaseRegistry, fallbackRegistry) : databaseRegistry;
        const protectedKeys = [...new Set(registry.windows
          .filter((entry) => entry.dirtyRecoveryKeys.some((key) => sameRecoveryScope(key, scope)))
          .flatMap((entry) => entry.dirtyRecoveryKeys.filter((key) => sameRecoveryScope(key, scope))))];
        if (protectedKeys.length) {
          outcome = { status: "protected", protectedKeys };
          return;
        }
        const checkpointStore = transaction.objectStore(RECOVERY_CHECKPOINT_STORE);
        const snapshotStore = transaction.objectStore(RECOVERY_STORE);
        const metadataStore = transaction.objectStore(RECOVERY_METADATA_STORE);
        checkpointStore.delete(scope);
        const snapshotCursor = snapshotStore.openCursor();
        snapshotCursor.onerror = () => { transaction.abort(); };
        snapshotCursor.onsuccess = () => {
          const cursor = snapshotCursor.result;
          if (!cursor) return;
          if (typeof cursor.key === "string" && sameRecoveryStorageScope(cursor.key, scope)) {
            removedKeys.add(cursor.key);
            snapshotStore.delete(cursor.key);
          }
          cursor.continue();
        };
        const metadataCursor = metadataStore.openCursor();
        let remainingBytes = 0;
        metadataCursor.onerror = () => { transaction.abort(); };
        metadataCursor.onsuccess = () => {
          const cursor = metadataCursor.result;
          if (!cursor) {
            metadataStore.put({ bytes: remainingBytes, updatedAt: Date.now() }, RECOVERY_METADATA_TOTAL_KEY);
            return;
          }
          if (typeof cursor.key === "string" && cursor.key !== RECOVERY_METADATA_TOTAL_KEY) {
            if (sameRecoveryStorageScope(cursor.key, scope)) {
              removedKeys.add(cursor.key);
              metadataStore.delete(cursor.key);
            } else {
              remainingBytes += readRecoveryMetadataRecord(cursor.value)?.bytes ?? 0;
            }
          }
          cursor.continue();
        };
        outcome = { status: "discarded" };
      };
      transaction.oncomplete = () => resolve(outcome ?? { status: "unavailable" });
      transaction.onerror = () => resolve({ status: "unavailable" });
      transaction.onabort = () => resolve(outcome?.status === "protected" ? outcome : { status: "unavailable" });
    } catch {
      resolve({ status: "unavailable" });
    }
  });
}

export function readSessionRegistryDatabase(database: IDBDatabase): Promise<SessionRegistry | null> {
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(RECOVERY_REGISTRY_STORE, "readonly");
      const request = transaction.objectStore(RECOVERY_REGISTRY_STORE).get(RECOVERY_REGISTRY_RECORD_KEY);
      let registry: SessionRegistry | null = null;
      request.onsuccess = () => { registry = readStoredSessionRegistry(request.result); };
      request.onerror = () => { registry = null; };
      transaction.oncomplete = () => resolve(registry);
      transaction.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function writeSessionRegistryDatabase(database: IDBDatabase, registry: SessionRegistry): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(RECOVERY_REGISTRY_STORE, "readwrite");
      transaction.objectStore(RECOVERY_REGISTRY_STORE).put({ registry } satisfies StoredSessionRegistryRecord, RECOVERY_REGISTRY_RECORD_KEY);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export function mutateSessionRegistryDatabase(database: IDBDatabase, mutate: (current: SessionRegistry) => SessionRegistry | null, fallbackRegistry: SessionRegistry | null = null): Promise<{ registry: SessionRegistry; saved: boolean; readSucceeded: boolean }> {
  return new Promise((resolve) => {
    let current = emptySessionRegistry();
    let next: SessionRegistry | null = null;
    let readSucceeded = false;
    let settled = false;
    const finish = (saved: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ registry: next ?? current, saved, readSucceeded });
    };
    try {
      const transaction = database.transaction(RECOVERY_REGISTRY_STORE, "readwrite");
      const request = transaction.objectStore(RECOVERY_REGISTRY_STORE).get(RECOVERY_REGISTRY_RECORD_KEY);
      request.onerror = () => {
        readSucceeded = false;
        try { transaction.abort(); } catch { finish(false); }
      };
      request.onsuccess = () => {
        try {
          const storedValue = request.result;
          const databaseRegistry = storedValue === undefined ? emptySessionRegistry() : readStoredSessionRegistry(storedValue);
          if (!databaseRegistry) {
            try { transaction.abort(); } catch { finish(false); }
            return;
          }
          current = fallbackRegistry ? mergeSessionRegistries(databaseRegistry, fallbackRegistry) : databaseRegistry;
          readSucceeded = true;
          next = mutate(current);
          if (next) transaction.objectStore(RECOVERY_REGISTRY_STORE).put({ registry: next } satisfies StoredSessionRegistryRecord, RECOVERY_REGISTRY_RECORD_KEY);
        } catch {
          readSucceeded = false;
          try { transaction.abort(); } catch { finish(false); }
        }
      };
      transaction.oncomplete = () => finish(Boolean(next));
      transaction.onerror = () => finish(false);
      transaction.onabort = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

/** Claims a recoverable scope and validates its checkpoint in the same IndexedDB transaction. */
export function claimRecoverableSessionWindowDatabase(
  database: IDBDatabase,
  input: ClaimRecoverableSessionCandidateInput,
): Promise<SessionRegistryResult & { checkpoint: SessionCheckpointMetadata | null }> {
  return new Promise((resolve) => {
    const now = nonNegativeTimestamp(input.now) ?? Date.now();
    const scope = input.candidate.scope;
    const lease: SessionWindowLease = { windowId: input.windowId, scope, leaseId: makeSessionId() };
    const fallbackRegistry = parseSessionRegistry(readStorage(SESSION_REGISTRY_STORAGE_KEY));
    let result: SessionRegistryResult | undefined;
    let registryLoaded = false;
    let databaseRegistry: SessionRegistry | null = null;
    let checkpointLoaded = false;
    let checkpointMetadata: SessionCheckpointMetadata | null = null;
    let pendingMetadata = 0;
    let failed = false;
    const unavailable = (): SessionRegistryResult => ({ ok: false, lease: null, registry: emptySessionRegistry(), staleWindowIds: [], reason: "unavailable" });

    try {
      const transaction = database.transaction([RECOVERY_REGISTRY_STORE, RECOVERY_CHECKPOINT_STORE, RECOVERY_METADATA_STORE], "readwrite");
      const registryStore = transaction.objectStore(RECOVERY_REGISTRY_STORE);
      const registryRequest = registryStore.get(RECOVERY_REGISTRY_RECORD_KEY);
      registryRequest.onerror = () => { failed = true; transaction.abort(); };
      registryRequest.onsuccess = () => {
        databaseRegistry = readStoredSessionRegistry(registryRequest.result);
        registryLoaded = true;
        tryCommit();
      };

      const checkpointRequest = transaction.objectStore(RECOVERY_CHECKPOINT_STORE).get(scope);
      checkpointRequest.onerror = () => { failed = true; transaction.abort(); };
      checkpointRequest.onsuccess = () => {
        const stored = checkpointRequest.result;
        if (isRecord(stored) && isRecord(stored.checkpoint)) {
          const metadataResult = parseSessionCheckpointMetadata(stored.checkpoint, Array.isArray(stored.recoveryKeys) ? stored.recoveryKeys : undefined, "indexeddb");
          checkpointMetadata = metadataResult?.checkpoint ?? null;
          if (!checkpointMetadata
            || checkpointMetadata.checkpointId !== input.candidate.checkpointId
            || checkpointMetadata.sequence !== input.candidate.sequence
            || checkpointMetadata.scope !== scope
            || checkpointMetadata.session.workspace !== input.workspace) {
            result = { ok: false, lease: null, registry: emptySessionRegistry(), staleWindowIds: [], reason: "conflict" };
            checkpointLoaded = true;
          } else {
            const metadataStore = transaction.objectStore(RECOVERY_METADATA_STORE);
            const dirtyTabs = checkpointMetadata.session.tabs.filter((tab) => tab.dirty);
            pendingMetadata = dirtyTabs.length;
            if (!pendingMetadata) checkpointLoaded = true;
            for (const tab of dirtyTabs) {
              const key = recoveryStorageKey(tab.id, scope);
              const metaRequest = metadataStore.get(key);
              metaRequest.onerror = () => { failed = true; transaction.abort(); };
              metaRequest.onsuccess = () => {
                const meta = readRecoveryMetadataRecord(metaRequest.result);
                if (!meta || meta.kind !== "snapshot" || meta.tabId !== tab.id || meta.path !== tab.path || meta.revision !== tab.revision) {
                  result = { ok: false, lease: null, registry: emptySessionRegistry(), staleWindowIds: [], reason: "conflict" };
                }
                pendingMetadata -= 1;
                if (!pendingMetadata) checkpointLoaded = true;
                tryCommit();
              };
            }
          }
        } else {
          checkpointLoaded = true;
        }
        tryCommit();
      };

      transaction.oncomplete = () => {
        const completed = result ?? unavailable();
        resolve({ ...completed, checkpoint: completed.ok ? checkpointMetadata : null });
      };
      transaction.onerror = () => resolve({ ...unavailable(), checkpoint: null });
      transaction.onabort = () => resolve({ ...unavailable(), checkpoint: null });

      function tryCommit() {
        if (!registryLoaded || !checkpointLoaded || pendingMetadata > 0 || failed || result) return;
        if (!checkpointMetadata) {
          result = { ok: false, lease: null, registry: emptySessionRegistry(), staleWindowIds: [], reason: "conflict" };
          return;
        }

        const current = fallbackRegistry
          ? mergeSessionRegistries(databaseRegistry ?? emptySessionRegistry(), fallbackRegistry)
          : databaseRegistry ?? emptySessionRegistry();
        const scopeWindows = current.windows.filter((entry) => entry.scope === scope && entry.workspace === input.workspace);
        const activeWindows = scopeWindows.filter((entry) => entry.status === "open" && now - entry.heartbeatAt <= SESSION_WINDOW_LEASE_MS);
        const staleWindows = scopeWindows.filter((entry) => entry.status === "open" && now - entry.heartbeatAt > SESSION_WINDOW_LEASE_MS);
        const closedWindows = scopeWindows.filter((entry) => entry.status === "closed");
        if (activeWindows.length || (!closedWindows.length && !(input.allowStale && staleWindows.length))) {
          result = {
            ok: false,
            lease: null,
            registry: current,
            staleWindowIds: current.windows.filter((entry) => entry.status === "open" && now - entry.heartbeatAt > SESSION_WINDOW_LEASE_MS).map((entry) => entry.windowId),
            reason: "conflict",
          };
          return;
        }

        const nextRecord: SessionWindowRecord = {
          ...lease,
          workspace: input.workspace,
          attachedAt: now,
          heartbeatAt: now,
          dirtyRecoveryKeys: [...new Set([
            ...checkpointMetadata.session.tabs.filter((tab) => tab.dirty).map((tab) => recoveryStorageKey(tab.id, scope)),
            ...(input.dirtyRecoveryKeys ?? []).filter((key) => isRecoveryStorageKey(key) && sameRecoveryScope(key, scope)),
          ])],
          status: "open",
        };
        const windows = current.windows
          .filter((entry) => entry.windowId !== input.windowId)
          .map((entry) => input.allowStale && entry.scope === scope && entry.status === "open" && now - entry.heartbeatAt > SESSION_WINDOW_LEASE_MS
            ? { ...entry, status: "closed" as const, closedAt: now, heartbeatAt: now }
            : entry);
        const boundedWindows = compactSessionWindows([...windows, nextRecord]);
        if (!boundedWindows) {
          result = { ok: false, lease: null, registry: current, staleWindowIds: [], reason: "capacity" };
          return;
        }
        const nextRegistry: SessionRegistry = { version: SESSION_REGISTRY_SCHEMA_VERSION, revision: current.revision + 1, updatedAt: now, windows: boundedWindows };
        registryStore.put({ registry: nextRegistry } satisfies StoredSessionRegistryRecord, RECOVERY_REGISTRY_RECORD_KEY);
        result = {
          ok: true,
          lease,
          registry: nextRegistry,
          staleWindowIds: nextRegistry.windows.filter((entry) => entry.status === "open" && now - entry.heartbeatAt > SESSION_WINDOW_LEASE_MS).map((entry) => entry.windowId),
        };
      }
    } catch {
      resolve({ ...unavailable(), checkpoint: null });
    }
  });
}

function readStoredSessionRegistry(value: unknown): SessionRegistry | null {
  if (isRecord(value) && "registry" in value) return parseSessionRegistry(value.registry);
  return parseSessionRegistry(value);
}
