/**
 * Session storage orchestration.
 *
 * This module coordinates the persistence queue, Web Locks, IndexedDB
 * transactions (session-storage-idb.ts), and the localStorage fallback
 * (session-storage-fallback.ts) using the schema and pure domain helpers in
 * session-storage-schema.ts. Public API and storage formats are unchanged.
 */
import {
  MAX_PATH_LENGTH,
  MAX_RECOVERY_BYTES,
  MAX_RECOVERY_TOTAL_BYTES,
  MAX_SESSION_WINDOWS,
  SESSION_CHECKPOINT_SCHEMA_VERSION,
  SESSION_CHECKPOINT_METADATA_STORAGE_PREFIX,
  SESSION_REGISTRY_SCHEMA_VERSION,
  SESSION_REGISTRY_STORAGE_KEY,
  SESSION_WINDOW_LEASE_MS,
  boundedString,
  compareSessionCheckpoints,
  compactSessionWindows,
  emptySessionRegistry,
  isRecord,
  isRecoveryBaselineKey,
  isRecoveryStorageKey,
  makeSessionId,
  mergeSessionRegistries,
  nonNegativeTimestamp,
  parseJson,
  parseRecovery,
  parseRecoveryBaseline,
  parseSession,
  parseSessionCheckpoint,
  parseSessionRegistry,
  parseSessionCheckpointMetadata,
  recoveryBaselineKey,
  recoveryBaselineSizeBytes,
  recoverySnapshotSizeBytes,
  recoverySnapshotStorageValue,
  recoveryStorageKey,
  sameRecoveryScope,
  sameSessionLease,
  sessionCheckpointStorageKey,
  sessionCheckpointMetadataStorageKey,
  updateRegistryForLease,
  type AttachSessionWindowInput,
  type ClaimSessionWindowInput,
  type ClaimSessionWindowResult,
  type DiscardSessionCheckpointResult,
  type RecoverableSession,
  type RecoverableSessionCandidate,
  type RecoveryBaseline,
  type RecoverySnapshot,
  type RecoveryStorageUsage,
  type RecoveryStorageValue,
  type StorageReadResult,
  type RecoveryWriteOptions,
  type SessionCheckpoint,
  type SessionCheckpointMetadata,
  type SessionCheckpointMetadataReadResult,
  type ClaimRecoverableSessionCandidateInput,
  type ClaimRecoverableSessionCandidateResult,
  type SessionCheckpointInput,
  type SessionCheckpointReadResult,
  type SessionCheckpointResult,
  type SessionMetadata,
  type SessionRegistry,
  type SessionRegistryResult,
  type SessionRegistryUpdateResult,
  type SessionWindowLease,
} from "./session-storage-schema";
import { getSessionLockManager, withGlobalSessionLock } from "./session-storage-locks";
import {
  getStorageSafe,
  mutateSessionRegistryFallback,
  readAllSessionCheckpointsFallback,
  readAllSessionCheckpointMetadataFallback,
  readSessionCheckpointMetadataFallback,
  readFallbackRecoveryEntries,
  readSessionCheckpointFallback,
  readSessionCheckpointFallbackBytes,
  readSessionRegistryFallback,
  readStorage,
  removeRecoveryFallback,
  writeFallbackRecoveryEntries,
  writeRecoveryFallback,
  writeSessionCheckpointFallback,
  writeSessionCheckpointMetadataFallback,
  removeSessionCheckpointBodyFallback,
  withSessionFallbackLock,
  MAX_FALLBACK_CHECKPOINT_BYTES,
  MAX_FALLBACK_RECOVERY_BYTES,
  writeSessionRegistryFallback,
} from "./session-storage-fallback";
import type * as SessionStorageIdb from "./session-storage-idb";

/**
 * IndexedDB access is loaded on demand so the IDB implementation (the largest
 * part of the persistence stack) stays out of the startup entry chunk. Every
 * call site is already inside an async persistence function.
 */
let sessionStorageIdbModule: Promise<typeof SessionStorageIdb> | undefined;
function sessionStorageIdb(): Promise<typeof SessionStorageIdb> {
  sessionStorageIdbModule ??= import("./session-storage-idb");
  return sessionStorageIdbModule;
}

let sessionPersistenceQueue: Promise<unknown> = Promise.resolve();

function enqueueSessionPersistence<T>(operation: () => Promise<T>): Promise<T> {
  const next = sessionPersistenceQueue.catch(() => undefined).then(operation);
  sessionPersistenceQueue = next.then(() => undefined, () => undefined);
  return next;
}

type FallbackRecoveryRead = { readable: true; raw: string | null; value: RecoveryStorageValue | null; invalid: boolean }
  | { readable: false; error: unknown };

function readFallbackRecoveryValue(key: string): FallbackRecoveryRead {
  const storage = getStorageSafe();
  if (!storage) return { readable: false, error: new Error("Local recovery storage is unavailable.") };
  try {
    const raw = storage.getItem(key);
    const parsed = raw === null ? null : parseRecovery(raw);
    return { readable: true, raw, value: parsed ? raw! : null, invalid: raw !== null && !parsed };
  } catch (error) {
    return { readable: false, error };
  }
}

function recoveryReadUnavailable<T>(error?: unknown, observedValue?: T): StorageReadResult<T> {
  return { status: "unavailable", ...(error === undefined ? {} : { error }), ...(observedValue === undefined ? {} : { observedValue }) };
}

function fallbackRecoveryReadResult(read: FallbackRecoveryRead): StorageReadResult<RecoveryStorageValue> {
  if (!read.readable) return recoveryReadUnavailable(read.error);
  if (read.invalid) return recoveryReadUnavailable(new Error("Stored recovery data is invalid."));
  return read.value === null ? { status: "missing" } : { status: "available", value: read.value };
}

/** Reads a recovery body without treating an inaccessible database as an empty one. */
export async function readRecoveryStorageResult(key: string): Promise<StorageReadResult<RecoveryStorageValue>> {
  const { RECOVERY_STORE, invalidateRecoveryDatabase, openRecoveryDatabase, readStoredRecoveryValue, selectRecoveryValue } = await sessionStorageIdb();
  const fallback = readFallbackRecoveryValue(key);
  if (typeof indexedDB === "undefined") return fallbackRecoveryReadResult(fallback);

  const database = await openRecoveryDatabase();
  if (!database) {
    const result = recoveryReadUnavailable(new Error("IndexedDB recovery storage could not be opened."), fallback.readable ? fallback.value ?? undefined : undefined);
    return result;
  }
  return new Promise((resolve) => {
    let settled = false;
    let didRead = false;
    let stored: unknown;
    let requestError: unknown;
    const finish = (result: StorageReadResult<RecoveryStorageValue>) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const unavailable = (error: unknown) => {
      invalidateRecoveryDatabase();
      finish(recoveryReadUnavailable(error, fallback.readable ? fallback.value ?? undefined : undefined));
    };
    try {
      const transaction = database.transaction(RECOVERY_STORE, "readonly");
      const request = transaction.objectStore(RECOVERY_STORE).get(key);
      request.onsuccess = () => { didRead = true; stored = request.result; };
      request.onerror = () => { requestError = request.error ?? new Error("IndexedDB recovery read failed."); };
      transaction.oncomplete = () => {
        if (requestError !== undefined || !didRead) {
          unavailable(requestError ?? new Error("IndexedDB recovery read did not complete."));
          return;
        }
        if (!fallback.readable) {
          const storedValue = readStoredRecoveryValue(stored);
          const parsedStored = storedValue === null ? null : parseRecovery(storedValue);
          if (stored !== undefined && storedValue !== null && parsedStored) finish(recoveryReadUnavailable(fallback.error, storedValue));
          else finish(recoveryReadUnavailable(fallback.error));
          return;
        }
        if (stored === undefined) {
          finish(fallbackRecoveryReadResult(fallback));
          return;
        }
        const databaseValue = readStoredRecoveryValue(stored);
        if (databaseValue === null || !parseRecovery(databaseValue)) {
          finish(recoveryReadUnavailable(new Error("IndexedDB contains an invalid recovery record."), fallback.value ?? undefined));
          return;
        }
        const value = selectRecoveryValue(databaseValue, fallback.invalid ? null : fallback.raw);
        if (value === null) {
          finish({ status: "missing" });
          return;
        }
        if (fallback.invalid && parseRecovery(value)?.revision === parseRecovery(databaseValue)?.revision) {
          finish(recoveryReadUnavailable(new Error("Local recovery data could not be validated."), databaseValue));
          return;
        }
        finish(value === null ? { status: "missing" } : { status: "available", value });
      };
      transaction.onerror = () => unavailable(transaction.error ?? requestError ?? new Error("IndexedDB recovery transaction failed."));
      transaction.onabort = () => unavailable(transaction.error ?? requestError ?? new Error("IndexedDB recovery transaction was aborted."));
    } catch (error) {
      unavailable(error);
    }
  });
}

/** Compatibility wrapper for older callers; restores use the status-bearing API. */
export async function readRecoveryStorage(key: string): Promise<RecoveryStorageValue | null> {
  const result = await readRecoveryStorageResult(key);
  return result.status === "available" ? result.value : null;
}

function readFallbackRecoveryBaseline(key: string): { readable: true; value: RecoveryBaseline | null; invalid: boolean }
  | { readable: false; error: unknown } {
  const storage = getStorageSafe();
  if (!storage) return { readable: false, error: new Error("Local recovery storage is unavailable.") };
  try {
    const raw = storage.getItem(key);
    const value = raw === null ? null : parseRecoveryBaseline(raw);
    return { readable: true, value, invalid: raw !== null && value === null };
  } catch (error) {
    return { readable: false, error };
  }
}

/** Reads a saved baseline and preserves the distinction between absent and unreadable. */
export async function readRecoveryBaselineResult(key: string): Promise<StorageReadResult<RecoveryBaseline>> {
  const { RECOVERY_STORE, invalidateRecoveryDatabase, openRecoveryDatabase } = await sessionStorageIdb();
  if (!isRecoveryBaselineKey(key)) return { status: "missing" };
  const fallback = readFallbackRecoveryBaseline(key);
  if (typeof indexedDB === "undefined") {
    if (!fallback.readable) return recoveryReadUnavailable(fallback.error);
    if (fallback.invalid) return recoveryReadUnavailable(new Error("Stored recovery baseline is invalid."));
    return fallback.value ? { status: "available", value: fallback.value } : { status: "missing" };
  }
  const database = await openRecoveryDatabase();
  if (!database) return recoveryReadUnavailable(new Error("IndexedDB recovery storage could not be opened."), fallback.readable ? fallback.value ?? undefined : undefined);
  return new Promise((resolve) => {
    let settled = false;
    let didRead = false;
    let stored: unknown;
    let requestError: unknown;
    const finish = (result: StorageReadResult<RecoveryBaseline>) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const unavailable = (error: unknown) => {
      invalidateRecoveryDatabase();
      finish(recoveryReadUnavailable(error, fallback.readable ? fallback.value ?? undefined : undefined));
    };
    try {
      const transaction = database.transaction(RECOVERY_STORE, "readonly");
      const request = transaction.objectStore(RECOVERY_STORE).get(key);
      request.onsuccess = () => { didRead = true; stored = request.result; };
      request.onerror = () => { requestError = request.error ?? new Error("IndexedDB baseline read failed."); };
      transaction.oncomplete = () => {
        if (requestError !== undefined || !didRead) {
          unavailable(requestError ?? new Error("IndexedDB baseline read did not complete."));
          return;
        }
        if (stored === undefined) {
          if (!fallback.readable) finish(recoveryReadUnavailable(fallback.error));
          else if (fallback.invalid) finish(recoveryReadUnavailable(new Error("Stored recovery baseline is invalid.")));
          else finish(fallback.value ? { status: "available", value: fallback.value } : { status: "missing" });
          return;
        }
        const raw = isRecord(stored) && "value" in stored ? stored.value : stored;
        const value = parseRecoveryBaseline(raw);
        if (!value) {
          finish(recoveryReadUnavailable(new Error("IndexedDB contains an invalid recovery baseline."), fallback.readable ? fallback.value ?? undefined : undefined));
          return;
        }
        if (fallback.readable && fallback.value) {
          if (fallback.value.savedRevision > value.savedRevision) {
            finish({ status: "available", value: fallback.value });
            return;
          }
          if (fallback.value.savedRevision === value.savedRevision && (fallback.value.savedContent !== value.savedContent || fallback.value.path !== value.path || fallback.value.tabId !== value.tabId)) {
            finish(recoveryReadUnavailable(new Error("Recovery baseline copies conflict."), value));
            return;
          }
        }
        finish({ status: "available", value });
      };
      transaction.onerror = () => unavailable(transaction.error ?? requestError ?? new Error("IndexedDB baseline transaction failed."));
      transaction.onabort = () => unavailable(transaction.error ?? requestError ?? new Error("IndexedDB baseline transaction was aborted."));
    } catch (error) {
      unavailable(error);
    }
  });
}

/** Compatibility wrapper for older callers; restores use the status-bearing API. */
export async function readRecoveryBaselineStorage(key: string): Promise<RecoveryBaseline | null> {
  const result = await readRecoveryBaselineResult(key);
  return result.status === "available" ? result.value : null;
}

export async function writeRecoveryStorage(key: string, value: RecoveryStorageValue, options: RecoveryWriteOptions = {}): Promise<boolean> {
  return enqueueSessionPersistence(async () => {
    const result = await withGlobalSessionLock((lockHeld) => writeRecoveryStorageInternal(key, value, options, lockHeld));
    return result === false ? false : result;
  });
}

async function writeRecoveryStorageInternal(key: string, value: RecoveryStorageValue, options: RecoveryWriteOptions, lockHeld = false): Promise<boolean> {
  const { openRecoveryDatabase, readRecoveryMetadataBytes, writeRecoveryDatabase } = await sessionStorageIdb();
  const snapshot = parseRecovery(value);
  if (!snapshot) return false;
  const stored = recoverySnapshotStorageValue(snapshot);
  const bytes = recoverySnapshotSizeBytes(snapshot);
  if (bytes > MAX_RECOVERY_BYTES) return false;
  const protectedRecoveryKeys = new Set((options.protectedRecoveryKeys ?? []).filter(isRecoveryStorageKey));
  const registry = await readSessionRegistryInternal(Date.now());
  registry.registry.windows.flatMap((entry) => entry.dirtyRecoveryKeys).forEach((protectedKey) => protectedRecoveryKeys.add(protectedKey));
  const database = await openRecoveryDatabase();
  if (!database) return await writeRecoveryFallback(key, stored, protectedRecoveryKeys, MAX_FALLBACK_RECOVERY_BYTES, lockHeld);
  const databaseBytesBefore = await readRecoveryMetadataBytes(database);
  const saved = await writeRecoveryDatabase(database, key, stored, bytes, MAX_RECOVERY_TOTAL_BYTES, protectedRecoveryKeys);
  if (saved) {
    await removeRecoveryFallback(key, lockHeld);
    return true;
  }
  const fallbackBudget = Math.min(MAX_FALLBACK_RECOVERY_BYTES, Math.max(0, MAX_RECOVERY_TOTAL_BYTES - databaseBytesBefore));
  return await writeRecoveryFallback(key, stored, protectedRecoveryKeys, fallbackBudget, lockHeld);
}

export async function removeRecoveryStorage(key: string): Promise<void> {
  return enqueueSessionPersistence(async () => {
    await withGlobalSessionLock((lockHeld) => removeRecoveryStorageInternal(key, lockHeld));
  });
}

async function removeRecoveryStorageInternal(key: string, lockHeld = false): Promise<void> {
  const { RECOVERY_METADATA_STORE, RECOVERY_STORE, invalidateRecoveryDatabase, openRecoveryDatabase } = await sessionStorageIdb();
  const database = await openRecoveryDatabase();
  if (!database) {
    await removeRecoveryFallback(key, lockHeld);
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction([RECOVERY_STORE, RECOVERY_METADATA_STORE], "readwrite");
      transaction.objectStore(RECOVERY_STORE).delete(key);
      const metadataStore = transaction.objectStore(RECOVERY_METADATA_STORE);
      const metadataRequest = metadataStore.get(key);
      const totalRequest = metadataStore.get("__pude_recovery_total_v1__");
      let metadataBytes = 0;
      let totalBytes: number | undefined;
      let readsPending = 2;
      const finishReads = () => {
        readsPending -= 1;
        if (readsPending > 0) return;
        metadataStore.delete(key);
        if (totalBytes !== undefined) {
          metadataStore.put({ bytes: Math.max(0, totalBytes - metadataBytes), updatedAt: Date.now() }, "__pude_recovery_total_v1__");
          return;
        }
        // Old databases may have no aggregate record. Rebuild it from small
        // metadata values only, excluding the entry removed above.
        const cursorRequest = metadataStore.openCursor();
        let rebuiltBytes = 0;
        cursorRequest.onerror = () => transaction.abort();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            metadataStore.put({ bytes: rebuiltBytes, updatedAt: Date.now() }, "__pude_recovery_total_v1__");
            return;
          }
          if (cursor.key !== "__pude_recovery_total_v1__") {
            const record = cursor.value;
            if (record && typeof record === "object" && "bytes" in record && typeof record.bytes === "number") rebuiltBytes += Math.max(0, record.bytes);
          }
          cursor.continue();
        };
      };
      metadataRequest.onsuccess = () => {
        const record = metadataRequest.result;
        if (record && typeof record === "object" && "bytes" in record && typeof record.bytes === "number") metadataBytes = Math.max(0, record.bytes);
        finishReads();
      };
      metadataRequest.onerror = () => { transaction.abort(); };
      totalRequest.onsuccess = () => {
        const record = totalRequest.result;
        if (record && typeof record === "object" && "bytes" in record && typeof record.bytes === "number") totalBytes = Math.max(0, record.bytes);
        finishReads();
      };
      totalRequest.onerror = () => { transaction.abort(); };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      invalidateRecoveryDatabase();
      resolve();
    }
  });
  await removeRecoveryFallback(key, lockHeld);
}

export async function readLatestSessionCheckpointStatus(scope: string): Promise<SessionCheckpointReadResult | null> {
  const { openRecoveryDatabase, readSessionCheckpointDatabase } = await sessionStorageIdb();
  if (!boundedString(scope, 256)) return null;
  const database = await openRecoveryDatabase();
  const [databaseResult, fallbackResult] = await Promise.all([
    database ? readSessionCheckpointDatabase(database, scope).catch(() => null) : Promise.resolve(null),
    readSessionCheckpointFallback(scope),
  ]);
  const candidates = [
    databaseResult ? { ...databaseResult, source: "indexeddb" as const } : null,
    fallbackResult ? { ...fallbackResult, source: "fallback" as const } : null,
  ].filter((candidate): candidate is SessionCheckpointReadResult => Boolean(candidate));
  candidates.sort((left, right) => compareSessionCheckpoints(left.checkpoint, right.checkpoint));
  return candidates.at(-1) ?? null;
}

/** Returns only a marker with a matching recovery for every dirty tab. */
export async function readLatestSessionCheckpoint(scope: string): Promise<SessionCheckpoint | null> {
  const { openRecoveryDatabase, readSessionCheckpointDatabase } = await sessionStorageIdb();
  if (!boundedString(scope, 256)) return null;
  const database = await openRecoveryDatabase();
  const [databaseResult, fallbackResult] = await Promise.all([
    database ? readSessionCheckpointDatabase(database, scope).catch(() => null) : Promise.resolve(null),
    readSessionCheckpointFallback(scope),
  ]);
  const complete = [databaseResult, fallbackResult]
    .filter((candidate): candidate is SessionCheckpointReadResult => Boolean(candidate?.complete))
    .sort((left, right) => compareSessionCheckpoints(left.checkpoint, right.checkpoint));
  return complete.at(-1)?.checkpoint ?? null;
}

/** Reads checkpoint metadata only, including data/reference completeness but never body integrity. */
export async function readLatestSessionCheckpointMetadata(scope: string): Promise<SessionCheckpointMetadataReadResult | null> {
  const { openRecoveryDatabase, readSessionCheckpointMetadataDatabase } = await sessionStorageIdb();
  if (!boundedString(scope, 256)) return null;
  const database = await openRecoveryDatabase();
  const [databaseResult, fallbackResult] = await Promise.all([
    database ? readSessionCheckpointMetadataDatabase(database, scope).catch(() => null) : Promise.resolve(null),
    readSessionCheckpointMetadataFallback(scope),
  ]);
  return latestCheckpointMetadata(databaseResult, fallbackResult);
}

function readFallbackCheckpointMetadataResult(scope: string): StorageReadResult<SessionCheckpointMetadataReadResult> {
  const storage = getStorageSafe();
  if (!storage) return recoveryReadUnavailable(new Error("Local checkpoint storage is unavailable."));
  try {
    const metadataRaw = storage.getItem(sessionCheckpointMetadataStorageKey(scope));
    if (metadataRaw !== null) {
      const rawValue = parseJson(metadataRaw);
      const keys = isRecord(rawValue) && Array.isArray(rawValue.recoveryKeys) ? rawValue.recoveryKeys : undefined;
      const parsed = parseSessionCheckpointMetadata(rawValue, keys, "fallback");
      if (parsed?.checkpoint.scope === scope) return { status: "available", value: parsed };
      return recoveryReadUnavailable(new Error("Stored fallback checkpoint metadata is invalid."));
    }
    const checkpointRaw = storage.getItem(sessionCheckpointStorageKey(scope));
    if (checkpointRaw !== null) {
      const checkpoint = parseSessionCheckpoint(checkpointRaw);
      if (!checkpoint || checkpoint.scope !== scope) return recoveryReadUnavailable(new Error("Stored fallback checkpoint is invalid."));
      const metadata = parseSessionCheckpointMetadata(checkpoint, Object.keys(checkpoint.recoveries), "fallback");
      return metadata ? { status: "available", value: metadata } : recoveryReadUnavailable(new Error("Stored fallback checkpoint metadata is invalid."));
    }
    return { status: "missing" };
  } catch (error) {
    return recoveryReadUnavailable(error);
  }
}

/** Reads checkpoint metadata and reports whether both configured stores could be checked. */
export async function readLatestSessionCheckpointMetadataResult(scope: string): Promise<StorageReadResult<SessionCheckpointMetadataReadResult>> {
  if (!boundedString(scope, 256)) return { status: "missing" };
  const { openRecoveryDatabase, readSessionCheckpointMetadataDatabase } = await sessionStorageIdb();
  const fallback = readFallbackCheckpointMetadataResult(scope);
  if (typeof indexedDB === "undefined") return fallback;
  const database = await openRecoveryDatabase();
  if (!database) {
    return recoveryReadUnavailable(
      new Error("IndexedDB checkpoint metadata could not be read."),
      fallback.status === "available" ? fallback.value : undefined,
    );
  }
  let databaseResult: SessionCheckpointMetadataReadResult | null;
  try {
    databaseResult = await readSessionCheckpointMetadataDatabase(database, scope);
  } catch (error) {
    return recoveryReadUnavailable(error, fallback.status === "available" ? fallback.value : undefined);
  }
  if (fallback.status === "unavailable") return recoveryReadUnavailable(fallback.error, databaseResult ?? undefined);
  if (fallback.status === "missing") return databaseResult ? { status: "available", value: databaseResult } : { status: "missing" };
  if (!databaseResult) return { status: "available", value: fallback.value };
  return {
    status: "available",
    value: compareSessionCheckpoints(databaseResult.checkpoint, fallback.value.checkpoint) >= 0 ? databaseResult : fallback.value,
  };
}

export type SessionCheckpointLoadOptions = {
  /** Metadata selected before taking the checkpoint body. This fences stale selections. */
  expected?: SessionCheckpointMetadata;
  lease?: SessionWindowLease;
};

function checkpointMatchesMetadata(checkpoint: SessionCheckpoint, metadata: SessionCheckpointMetadataReadResult): boolean {
  const expected = metadata.checkpoint;
  if (!metadata.completeMetadata
    || checkpoint.scope !== expected.scope
    || checkpoint.checkpointId !== expected.checkpointId
    || checkpoint.sequence !== expected.sequence
    || checkpoint.committedAt !== expected.committedAt
    || checkpoint.session.workspace !== expected.session.workspace
    || JSON.stringify(checkpoint.session) !== JSON.stringify(expected.session)) return false;
  const expectedKeys = [...expected.recoveryKeys].sort();
  const actualKeys = Object.keys(checkpoint.recoveries).sort();
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) return false;
  const expectedRevisions = Object.entries(expected.recoveryRevisions).sort(([left], [right]) => left.localeCompare(right));
  const actualRevisions = Object.entries(checkpoint.recoveryRevisions).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(expectedRevisions) !== JSON.stringify(actualRevisions)) return false;
  return expectedKeys.every((key) => {
    const snapshot = checkpoint.recoveries[key];
    return snapshot && expected.recoveryRevisions[key] === snapshot.revision;
  });
}

function sameSelectedCheckpointMetadata(left: SessionCheckpointMetadata, right: SessionCheckpointMetadata): boolean {
  return left.scope === right.scope
    && left.checkpointId === right.checkpointId
    && left.sequence === right.sequence
    && left.committedAt === right.committedAt
    && left.session.workspace === right.session.workspace
    && JSON.stringify(left.session) === JSON.stringify(right.session)
    && JSON.stringify([...left.recoveryKeys].sort()) === JSON.stringify([...right.recoveryKeys].sort())
    && JSON.stringify(Object.entries(left.recoveryRevisions).sort(([a], [b]) => a.localeCompare(b)))
      === JSON.stringify(Object.entries(right.recoveryRevisions).sort(([a], [b]) => a.localeCompare(b)));
}

function readFallbackCheckpointBodyResult(scope: string): StorageReadResult<SessionCheckpoint> {
  const storage = getStorageSafe();
  if (!storage) return recoveryReadUnavailable(new Error("Local checkpoint storage is unavailable."));
  try {
    const raw = storage.getItem(sessionCheckpointStorageKey(scope));
    if (raw === null) return { status: "missing" };
    const checkpoint = parseSessionCheckpoint(raw);
    return checkpoint?.scope === scope
      ? { status: "available", value: checkpoint }
      : recoveryReadUnavailable(new Error("Stored fallback checkpoint is invalid."));
  } catch (error) {
    return recoveryReadUnavailable(error);
  }
}

/** Loads a selected checkpoint body only after validating its current metadata and source availability. */
export async function loadSessionCheckpointResult(scope: string, options: SessionCheckpointLoadOptions = {}): Promise<StorageReadResult<SessionCheckpoint>> {
  if (!boundedString(scope, 256) || (options.lease && options.lease.scope !== scope)) return { status: "missing" };
  const metadataResult = await readLatestSessionCheckpointMetadataResult(scope);
  if (metadataResult.status === "missing") return { status: "missing" };
  if (metadataResult.status === "unavailable") return recoveryReadUnavailable(metadataResult.error);
  const metadata = metadataResult.value;
  if (options.expected && !sameSelectedCheckpointMetadata(options.expected, metadata.checkpoint)) {
    return recoveryReadUnavailable(new Error("Selected checkpoint metadata changed before its body was loaded."));
  }
  if (metadata.checkpoint.scope !== scope) {
    return recoveryReadUnavailable(new Error("Selected checkpoint metadata is invalid."));
  }
  const leaseIsCurrent = async () => {
    if (!options.lease) return true;
    const registry = await readSessionRegistryInternal(Date.now());
    return registry.registry.windows.some((entry) => sameSessionLease(entry, options.lease!) && entry.status === "open");
  };
  const selectionIsStillCurrent = async (): Promise<boolean> => {
    const latest = await readLatestSessionCheckpointMetadataResult(scope);
    return latest.status === "available" && sameSelectedCheckpointMetadata(metadata.checkpoint, latest.value.checkpoint);
  };
  if (!await leaseIsCurrent()) return recoveryReadUnavailable(new Error("Checkpoint lease could not be verified."));

  const fallback = readFallbackCheckpointBodyResult(scope);
  if (typeof indexedDB === "undefined") {
    if (fallback.status !== "available") return fallback;
    if (!checkpointMatchesMetadata(fallback.value, metadata)) {
      return recoveryReadUnavailable(new Error("Fallback checkpoint does not match the selected metadata."), fallback.value);
    }
    if (!await selectionIsStillCurrent() || !await leaseIsCurrent()) return recoveryReadUnavailable(new Error("Checkpoint selection changed while its fallback body was loading."));
    return { status: "available", value: fallback.value };
  }
  const { openRecoveryDatabase, readSessionCheckpointDatabase } = await sessionStorageIdb();
  const database = await openRecoveryDatabase();
  if (!database) return recoveryReadUnavailable(new Error("IndexedDB checkpoint body could not be read."), fallback.status === "available" ? fallback.value : undefined);
  let databaseResult: SessionCheckpointReadResult | null;
  try {
    databaseResult = await readSessionCheckpointDatabase(database, scope);
  } catch (error) {
    return recoveryReadUnavailable(error, fallback.status === "available" ? fallback.value : undefined);
  }
  if (databaseResult) {
    const ordering = compareSessionCheckpoints(databaseResult.checkpoint, metadata.checkpoint);
    if (ordering > 0 || (ordering === 0 && !checkpointMatchesMetadata(databaseResult.checkpoint, metadata))) {
      return recoveryReadUnavailable(new Error("IndexedDB checkpoint body changed after metadata selection."), fallback.status === "available" ? fallback.value : undefined);
    }
  }
  if (databaseResult?.complete && checkpointMatchesMetadata(databaseResult.checkpoint, metadata)) {
    if (!await selectionIsStillCurrent() || !await leaseIsCurrent()) return recoveryReadUnavailable(new Error("Checkpoint selection changed while its body was loading."));
    return { status: "available", value: databaseResult.checkpoint };
  }
  if (fallback.status === "available" && checkpointMatchesMetadata(fallback.value, metadata)) {
    if (!await selectionIsStillCurrent() || !await leaseIsCurrent()) return recoveryReadUnavailable(new Error("Checkpoint selection changed while its fallback body was loading."));
    return { status: "available", value: fallback.value };
  }
  return recoveryReadUnavailable(
    fallback.status === "unavailable" ? fallback.error : new Error("Selected checkpoint body is missing or does not match its metadata."),
    fallback.status === "available" ? fallback.value : undefined,
  );
}

/** Registers a UI callback for an IndexedDB upgrade blocked by an older connection. */
export async function setRecoveryDatabaseBlockedHandler(handler: ((timeoutMs: number, status: "blocked" | "timed-out") => void) | undefined): Promise<void> {
  const { setRecoveryDatabaseBlockedHandler: setHandler } = await sessionStorageIdb();
  setHandler(handler);
}

export async function commitSessionCheckpoint(input: SessionCheckpointInput): Promise<SessionCheckpointResult> {
  return enqueueSessionPersistence(async () => {
    const result = await withGlobalSessionLock((lockHeld) => commitSessionCheckpointInternal(input, lockHeld));
    return result === false ? invalidCheckpointResult("unavailable") : result;
  });
}

/** Waits until all checkpoint, registry, and legacy recovery writes queued in this renderer finish. */
export async function flushSessionPersistence(): Promise<void> {
  await sessionPersistenceQueue.catch(() => undefined);
}

export async function attachSessionWindow(input: AttachSessionWindowInput): Promise<SessionRegistryResult> {
  return enqueueSessionPersistence(async () => {
    const result = await withGlobalSessionLock((lockHeld) => attachSessionWindowInternal(input, false, lockHeld));
    return result === false ? { ok: false, lease: null, registry: emptySessionRegistry(), staleWindowIds: [], reason: "unavailable" as const } : result;
  });
}

export async function heartbeatSessionWindow(lease: SessionWindowLease, dirtyRecoveryKeys?: readonly string[], now = Date.now()): Promise<SessionRegistryUpdateResult> {
  return enqueueSessionPersistence(async () => {
    const result = await withGlobalSessionLock((lockHeld) => updateSessionWindowInternal(lease, dirtyRecoveryKeys, now, lockHeld));
    return result === false ? { ok: false, registry: emptySessionRegistry(), reason: "unavailable" as const } : result;
  });
}

export async function closeSessionWindow(lease: SessionWindowLease, options: { discardRecovery?: boolean; now?: number } = {}): Promise<SessionRegistryUpdateResult> {
  return enqueueSessionPersistence(async () => {
    const result = await withGlobalSessionLock((lockHeld) => closeSessionWindowInternal(lease, options, lockHeld));
    return result === false ? { ok: false, registry: emptySessionRegistry(), reason: "unavailable" as const } : result;
  });
}

export async function readSessionRegistry(now = Date.now()): Promise<SessionRegistry> {
  const result = await readSessionRegistryInternal(now);
  return result.registry;
}

export async function listRecoverableSessionCheckpoints(workspace?: string): Promise<RecoverableSession[]> {
  const { openRecoveryDatabase, readAllSessionCheckpointsDatabase } = await sessionStorageIdb();
  const database = await openRecoveryDatabase();
  const [databaseResults, fallbackResults, registry] = await Promise.all([
    database ? readAllSessionCheckpointsDatabase(database) : Promise.resolve([]),
    readAllSessionCheckpointsFallback(),
    readSessionRegistryInternal(Date.now()),
  ]);
  const byScope = new Map<string, RecoverableSession>();
  for (const candidate of [...databaseResults, ...fallbackResults]) {
    if (workspace !== undefined && candidate.checkpoint.session.workspace !== workspace) continue;
    const existing = byScope.get(candidate.checkpoint.scope);
    const recoverable: RecoverableSession = { ...candidate, workspace: candidate.checkpoint.session.workspace, activeWindowIds: [], staleWindowIds: [], closedWindowIds: [] };
    if (!existing || compareSessionCheckpoints(existing.checkpoint, candidate.checkpoint) < 0) byScope.set(candidate.checkpoint.scope, recoverable);
  }
  for (const candidate of byScope.values()) {
    const windows = registry.registry.windows.filter((entry) => entry.scope === candidate.checkpoint.scope && entry.workspace === candidate.checkpoint.session.workspace);
    const staleIds = new Set(registry.staleWindowIds);
    candidate.activeWindowIds = windows.filter((entry) => entry.status === "open" && !staleIds.has(entry.windowId)).map((entry) => entry.windowId);
    candidate.staleWindowIds = windows.filter((entry) => entry.status === "open" && staleIds.has(entry.windowId)).map((entry) => entry.windowId);
    candidate.closedWindowIds = windows.filter((entry) => entry.status === "closed").map((entry) => entry.windowId);
  }
  return [...byScope.values()].sort((left, right) => compareSessionCheckpoints(right.checkpoint, left.checkpoint));
}

/** Lists recoverable candidates using checkpoint and ownership metadata only. */
export async function listRecoverableSessionCheckpointCandidates(workspace?: string): Promise<RecoverableSessionCandidate[]> {
  const { openRecoveryDatabase, readSessionCheckpointCandidatesDatabase } = await sessionStorageIdb();
  const database = await openRecoveryDatabase();
  const [databaseResults, fallbackResults, registry] = await Promise.all([
    database ? readSessionCheckpointCandidatesDatabase(database, workspace) : Promise.resolve([]),
    readAllSessionCheckpointMetadataFallback(workspace),
    readSessionRegistryInternal(Date.now()),
  ]);
  const byScope = new Map<string, SessionCheckpointMetadataReadResult>();
  for (const candidate of [...databaseResults, ...fallbackResults]) {
    if (workspace !== undefined && candidate.checkpoint.session.workspace !== workspace) continue;
    const existing = byScope.get(candidate.checkpoint.scope);
    if (!existing || compareSessionCheckpoints(existing.checkpoint, candidate.checkpoint) < 0) byScope.set(candidate.checkpoint.scope, candidate);
  }
  const staleIds = new Set(registry.staleWindowIds);
  const result: RecoverableSessionCandidate[] = [];
  for (const candidate of byScope.values()) {
    const windows = registry.registry.windows.filter((entry) => entry.scope === candidate.checkpoint.scope && entry.workspace === candidate.checkpoint.session.workspace);
    result.push({
      ...candidate,
      workspace: candidate.checkpoint.session.workspace,
      activeWindowIds: windows.filter((entry) => entry.status === "open" && !staleIds.has(entry.windowId)).map((entry) => entry.windowId),
      staleWindowIds: windows.filter((entry) => entry.status === "open" && staleIds.has(entry.windowId)).map((entry) => entry.windowId),
      closedWindowIds: windows.filter((entry) => entry.status === "closed").map((entry) => entry.windowId),
    });
  }
  return result.sort((left, right) => compareSessionCheckpoints(right.checkpoint, left.checkpoint));
}

/** Loads and validates one selected checkpoint after candidate metadata has been shown. */
export async function loadSessionCheckpoint(
  scope: string,
  options: { expectedCheckpointId?: string; lease?: SessionWindowLease } = {},
): Promise<SessionCheckpoint | null> {
  if (!boundedString(scope, 256)) return null;
  if (options.lease && options.lease.scope !== scope) return null;
  const leaseIsCurrent = async () => {
    if (!options.lease) return true;
    const registry = await readSessionRegistryInternal(Date.now());
    return registry.registry.windows.some((entry) => sameSessionLease(entry, options.lease!) && entry.status === "open");
  };
  // Avoid loading a recovery body when the caller's owner token was already
  // fenced. Recheck afterward so a takeover during the read cannot return a
  // checkpoint as writable under an expired lease.
  if (!await leaseIsCurrent()) return null;
  const checkpoint = await readLatestSessionCheckpoint(scope);
  if (!checkpoint || checkpoint.scope !== scope) return null;
  if (options.expectedCheckpointId && checkpoint.checkpointId !== options.expectedCheckpointId) return null;
  if (!await leaseIsCurrent()) return null;
  return checkpoint;
}

/** Claims a closed scope, or an explicitly allowed stale scope, for a new window. */
export async function claimSessionWindow(input: ClaimSessionWindowInput): Promise<ClaimSessionWindowResult> {
  return enqueueSessionPersistence(async () => {
    const result = await withGlobalSessionLock((lockHeld) => claimSessionWindowInternal(input, lockHeld));
    return result === false ? { ok: false, lease: null, registry: emptySessionRegistry(), staleWindowIds: [], reusedScope: false, reason: "unavailable" as const } : result;
  });
}

/** Claims the exact metadata candidate selected by the user without loading any recovery bodies. */
export async function claimRecoverableSessionCandidate(input: ClaimRecoverableSessionCandidateInput): Promise<ClaimRecoverableSessionCandidateResult> {
  return enqueueSessionPersistence(async () => {
    const result = await withGlobalSessionLock((lockHeld) => claimRecoverableSessionCandidateInternal(input, lockHeld));
    return result === false
      ? { ok: false, lease: null, registry: emptySessionRegistry(), staleWindowIds: [], reusedScope: false, checkpoint: null, reason: "unavailable" as const }
      : result;
  });
}

export async function discardSessionCheckpoint(scope: string): Promise<DiscardSessionCheckpointResult> {
  return enqueueSessionPersistence(async () => {
    const result = await withGlobalSessionLock((lockHeld) => discardSessionCheckpointInternal(scope, lockHeld));
    return result === false ? { ok: false, removedKeys: [], reason: "unavailable" as const } : result;
  });
}

export async function getRecoveryStorageUsage(): Promise<RecoveryStorageUsage> {
  const { openRecoveryDatabase, readRecoveryMetadataBytes } = await sessionStorageIdb();
  const database = await openRecoveryDatabase();
  const [indexedDbBytes, fallbackBytes] = await Promise.all([
    database ? readRecoveryMetadataBytes(database) : Promise.resolve(0),
    Promise.resolve(readFallbackRecoveryEntries(getStorageSafe()).reduce((total, entry) => total + entry.bytes, 0)),
  ]);
  return { indexedDbBytes, fallbackBytes, totalBytes: indexedDbBytes + fallbackBytes, limitBytes: MAX_RECOVERY_TOTAL_BYTES };
}

async function commitSessionCheckpointInternal(input: SessionCheckpointInput, lockHeld = false): Promise<SessionCheckpointResult> {
  const { openRecoveryDatabase, readRecoveryMetadataBytes, readCheckpointRecoveryBytes, readSessionCheckpointMetadataDatabase, writeSessionCheckpointDatabase } = await sessionStorageIdb();
  if (!boundedString(input.scope, 256)) return invalidCheckpointResult("invalid");
  let session: SessionMetadata | null = null;
  try {
    session = parseSession(JSON.stringify(input.session));
  } catch {
    session = null;
  }
  if (!session) return invalidCheckpointResult("invalid");
  const now = nonNegativeTimestamp(input.now) ?? Date.now();
  const registryResult = await readSessionRegistryInternal(now);
  const lease = input.lease;
  if (lease && !registryResult.registry.windows.some((entry) => sameSessionLease(entry, lease) && entry.status === "open")) {
    return invalidCheckpointResult("invalid");
  }
  const liveOwner = registryResult.registry.windows.find((entry) => entry.scope === input.scope && entry.status === "open");
  if (liveOwner && (!lease || !sameSessionLease(liveOwner, lease))) return invalidCheckpointResult("conflict");
  const database = await openRecoveryDatabase();
  if (typeof indexedDB !== "undefined" && !database) return invalidCheckpointResult("unavailable");
  const previousRead = await readLatestSessionCheckpointMetadataResult(input.scope);
  if (previousRead.status === "unavailable") return invalidCheckpointResult("unavailable");
  const previousResult = previousRead.status === "available" ? previousRead.value : null;
  const build = buildSessionCheckpoint(input, session, previousResult, registryResult.registry, now);
  if (build.missingRecoveryKeys.length) return invalidCheckpointResult("missing-recovery", build.missingRecoveryKeys);
  if (!build.checkpoint) return invalidCheckpointResult("invalid");
  const checkpoint = build.checkpoint;
  const protectedRecoveryKeys = build.protectedRecoveryKeys;
  const databaseResult = database
    ? await writeSessionCheckpointDatabase(database, checkpoint, build.recoveries, build.baselines, protectedRecoveryKeys, MAX_RECOVERY_TOTAL_BYTES, lease)
    : { saved: false, skipped: true, evictedKeys: [] as string[] };
  let fallbackResult = { saved: false, skipped: true, evictedKeys: [] as string[] };
  if (databaseResult.saved) {
    // IndexedDB owns the full recovery bodies on the normal path. Keep only a
    // small metadata sidecar for localStorage-based candidate discovery.
    writeSessionCheckpointMetadataFallback(checkpoint);
    removeSessionCheckpointBodyFallback(input.scope);
  } else {
    const indexedDbBytesBefore = database ? await readRecoveryMetadataBytes(database) : 0;
    const scopedBytes = database
      ? await readCheckpointRecoveryBytes(database, input.scope)
      : fallbackCheckpointStoredBytes(input.scope);
    const fallbackBudget = Math.min(MAX_FALLBACK_CHECKPOINT_BYTES, Math.max(0, MAX_RECOVERY_TOTAL_BYTES - indexedDbBytesBefore));
    const preflightBytes = estimateMetadataBytes(checkpoint)
      + (scopedBytes ?? 0)
      + Object.values(build.recoveries).reduce((total, snapshot) => total + recoverySnapshotSizeBytes(snapshot), 0)
      + Object.values(build.baselines).reduce((total, baseline) => total + recoveryBaselineSizeBytes(baseline), 0);
    if (preflightBytes <= fallbackBudget && getStorageSafe()) {
      const previousFullRead = await loadSessionCheckpointResult(input.scope, {
        ...(previousResult ? { expected: previousResult.checkpoint } : {}),
      });
      if (previousFullRead.status === "unavailable"
        || (previousResult && previousFullRead.status !== "available")
        || (!previousResult && previousFullRead.status === "available")) {
        return invalidCheckpointResult("unavailable");
      }
      const previousFull = previousFullRead.status === "available" ? previousFullRead.value : null;
      const recoveries: Record<string, RecoverySnapshot> = {};
      const tabsByKey = new Map(checkpoint.session.tabs.map((tab) => [recoveryStorageKey(tab.id, checkpoint.scope), tab]));
      for (const key of checkpoint.recoveryKeys) {
        const snapshot = build.recoveries[key] ?? previousFull?.recoveries[key];
        const tab = tabsByKey.get(key);
        if (!snapshot || !tab || snapshot.tabId !== tab.id || snapshot.path !== tab.path || snapshot.revision !== tab.revision) {
          build.missingRecoveryKeys.push(key);
          continue;
        }
        recoveries[key] = snapshot;
      }
      if (!build.missingRecoveryKeys.length) {
        const fullCheckpoint: SessionCheckpoint = { ...checkpoint, recoveries };
        const fallbackBaselines = { ...build.baselines };
        carryForwardCheckpointBaselines(fallbackBaselines, input.scope, fullCheckpoint, previousFull);
        const form = fallbackCheckpointForm(fullCheckpoint, fallbackBaselines);
        const estimateBytes = estimateJsonBytes(form);
        fallbackResult = await writeSessionCheckpointFallback(
          fullCheckpoint,
          protectedRecoveryKeys,
          fallbackBudget,
          estimateBytes,
          () => JSON.stringify(form),
          lease,
          lockHeld,
        );
      }
    }
  }
  if (!databaseResult.saved && lease) {
    await mutateSessionRegistryFallback((current) => updateRegistryForLease(current, lease, session.tabs.filter((tab) => tab.dirty).map((tab) => recoveryStorageKey(tab.id, input.scope)), now), lockHeld);
  }
  const fallbackDurability = fallbackResult.saved;
  const databaseDurability = databaseResult.saved;
  const durability: SessionCheckpointResult["durability"] = databaseDurability && fallbackDurability
    ? "both"
    : databaseDurability
      ? "indexeddb"
      : fallbackDurability
        ? "fallback"
        : "none";
  const ok = durability !== "none";
  const storageAvailable = Boolean(database || getStorageSafe());
  const fallbackMutationAvailable = Boolean(database || getSessionLockManager());
  return {
    ok,
    complete: ok && build.missingRecoveryKeys.length === 0,
    checkpoint: ok ? checkpoint : null,
    updatedRecoveryKeys: Object.keys(build.recoveries),
    removedRecoveryKeys: build.removedRecoveryKeys,
    durability,
    fallback: fallbackResult.saved ? "committed" : fallbackResult.skipped ? "skipped" : "failed",
    evictedKeys: [...new Set([...fallbackResult.evictedKeys, ...databaseResult.evictedKeys])],
    reason: ok ? (build.missingRecoveryKeys.length ? "missing-recovery" : undefined) : !storageAvailable || !fallbackMutationAvailable ? "unavailable" : (Boolean(database && databaseResult.skipped) || fallbackResult.skipped) ? "quota" : "unavailable",
    missingRecoveryKeys: build.missingRecoveryKeys,
  };
}

function buildSessionCheckpoint(
  input: SessionCheckpointInput,
  session: SessionMetadata,
  previousResult: SessionCheckpointMetadataReadResult | null,
  registry: SessionRegistry,
  now: number,
): { checkpoint: SessionCheckpointMetadata | null; recoveries: Record<string, RecoverySnapshot>; baselines: Record<string, RecoveryBaseline>; missingRecoveryKeys: string[]; protectedRecoveryKeys: Set<string>; removedRecoveryKeys: string[] } {
  const previous = previousResult?.checkpoint ?? null;
  const currentTabs = new Map(session.tabs.map((tab) => [tab.id, tab]));
  const dirtyKeys = new Set(session.tabs.filter((tab) => tab.dirty).map((tab) => recoveryStorageKey(tab.id, input.scope)));
  const protectedRecoveryKeys = new Set<string>([
    ...dirtyKeys,
    ...(input.protectedRecoveryKeys ?? []).filter(isRecoveryStorageKey),
    ...registry.windows.flatMap((entry) => entry.dirtyRecoveryKeys),
  ]);
  const updates = new Map<string, RecoverySnapshot>();
  for (const candidate of input.recoveries ?? []) {
    const snapshot = parseRecovery(candidate);
    const tab = currentTabs.get(candidate.tabId);
    if (!snapshot || !tab || !tab.dirty || snapshot.tabId !== candidate.tabId || snapshot.path !== tab.path) continue;
    updates.set(recoveryStorageKey(snapshot.tabId, input.scope), snapshot);
  }
  const baselines: Record<string, RecoveryBaseline> = {};
  for (const candidate of input.baselines ?? []) {
    const baseline = parseRecoveryBaseline(candidate);
    const tab = currentTabs.get(candidate.tabId);
    if (!baseline || !tab || !tab.dirty || baseline.tabId !== candidate.tabId || baseline.path !== tab.path) continue;
    baselines[recoveryBaselineKey(baseline.tabId, input.scope)] = baseline;
  }
  const removed = new Set((input.recoveryKeysToRemove ?? []).filter(isRecoveryStorageKey));
  const unavailable = new Set((input.unavailableRecoveryKeys ?? []).filter(isRecoveryStorageKey));
  const recoveries: Record<string, RecoverySnapshot> = {};
  const recoveryKeys: string[] = [];
  const recoveryRevisions: Record<string, number | null> = {};
  const missingRecoveryKeys: string[] = [];
  for (const tab of session.tabs) {
    const key = recoveryStorageKey(tab.id, input.scope);
    if (!tab.dirty) continue;
    if (unavailable.has(key)) {
      missingRecoveryKeys.push(key);
      continue;
    }
    const next = updates.get(key);
    const previousTab = previous?.session.tabs.find((candidate) => candidate.id === tab.id);
    const hasPrevious = Boolean(previousResult?.completeMetadata
      && previous?.recoveryKeys.includes(key)
      && previous.recoveryRevisions[key] === tab.revision
      && previousTab?.path === tab.path);
    const validNext = Boolean(next && next.tabId === tab.id && next.path === tab.path && next.revision === tab.revision && next.revision > tab.savedRevision);
    if (removed.has(key) || (!validNext && !hasPrevious)) {
      missingRecoveryKeys.push(key);
      continue;
    }
    if (next && validNext) recoveries[key] = next;
    recoveryKeys.push(key);
    recoveryRevisions[key] = tab.revision;
  }
  const removedRecoveryKeys = [...new Set([
    ...((previous?.recoveryKeys ?? []).filter((key) => !recoveryKeys.includes(key))),
    ...[...removed].filter((key) => sameRecoveryScope(key, input.scope)),
  ])];
  if (missingRecoveryKeys.length) return { checkpoint: null, recoveries, baselines, missingRecoveryKeys, protectedRecoveryKeys, removedRecoveryKeys };
  const sequence = (previous?.sequence ?? 0) + 1;
  const checkpoint: SessionCheckpointMetadata = {
    version: SESSION_CHECKPOINT_SCHEMA_VERSION,
    scope: input.scope,
    checkpointId: `${encodeURIComponent(input.scope)}:${sequence}:${makeSessionId()}`,
    sequence,
    committedAt: now,
    session,
    recoveryRevisions,
    recoveryKeys,
  };
  return { checkpoint, recoveries, baselines, missingRecoveryKeys, protectedRecoveryKeys, removedRecoveryKeys };
}

/** Self-contained fallback JSON: v2 snapshots keep their baselines inline. */
function fallbackCheckpointForm(checkpoint: SessionCheckpoint, baselines: Record<string, RecoveryBaseline>) {
  return { ...checkpoint, baselines };
}

/**
 * Fills the fallback baseline map for snapshots that reference a durable
 * baseline record which is not being rewritten by this commit. Only the
 * fallback serialization uses the carried-forward entries; the IndexedDB
 * write receives just the new baselines so unchanged baselines are not
 * re-cloned on every commit.
 */
function carryForwardCheckpointBaselines(baselines: Record<string, RecoveryBaseline>, scope: string, checkpoint: SessionCheckpoint, previous: SessionCheckpoint | null): void {
  for (const [key, snapshot] of Object.entries(checkpoint.recoveries)) {
    if (snapshot.version !== 2 || snapshot.savedRevision === undefined) continue;
    const baselineKey = recoveryBaselineKey(snapshot.tabId, scope);
    if (baselines[baselineKey]) continue;
    const source = !snapshot.savedContentUnavailable ? snapshot : previous?.recoveries[key];
    if (!source || source.version !== 2 || source.savedRevision !== snapshot.savedRevision || source.savedContentUnavailable) continue;
    baselines[baselineKey] = {
      version: 1,
      tabId: source.tabId,
      path: source.path,
      savedRevision: source.savedRevision,
      savedContent: source.savedContent,
      ...(source.savedLineEndings !== undefined ? { savedLineEndings: source.savedLineEndings } : {}),
      ...(source.savedBom !== undefined ? { savedBom: source.savedBom } : {}),
      ...(source.encoding !== undefined ? { encoding: source.encoding } : {}),
    };
  }
}

function invalidCheckpointResult(reason: SessionCheckpointResult["reason"], missingRecoveryKeys: string[] = []): SessionCheckpointResult {
  return { ok: false, complete: false, checkpoint: null, updatedRecoveryKeys: [], removedRecoveryKeys: [], durability: "none", fallback: "failed", evictedKeys: [], missingRecoveryKeys, reason };
}

function latestCheckpointMetadata(
  databaseResult: SessionCheckpointMetadataReadResult | null,
  fallbackResult: SessionCheckpointMetadataReadResult | null,
): SessionCheckpointMetadataReadResult | null {
  const candidates = [databaseResult, fallbackResult].filter((candidate): candidate is SessionCheckpointMetadataReadResult => Boolean(candidate));
  candidates.sort((left, right) => compareSessionCheckpoints(left.checkpoint, right.checkpoint));
  return candidates.at(-1) ?? null;
}

function estimateMetadataBytes(checkpoint: SessionCheckpointMetadata): number {
  return estimateJsonBytes(checkpoint);
}

function fallbackCheckpointStoredBytes(scope: string): number {
  return readSessionCheckpointFallbackBytes(scope) ?? 0;
}

/** Computes a safe UTF-8 size estimate without allocating a serialized copy. */
function estimateJsonBytes(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === "string") return estimateJsonStringBytes(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (Array.isArray(value)) return 2 + value.reduce((total, item, index) => total + (index ? 1 : 0) + estimateJsonBytes(item), 0);
  if (isRecord(value)) {
    let total = 2;
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      total += (first ? 0 : 1) + estimateJsonStringBytes(key) + 1 + estimateJsonBytes(item);
      first = false;
    }
    return total;
  }
  return 4;
}

function estimateJsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

async function discardSessionCheckpointInternal(scope: string, lockHeld = false): Promise<DiscardSessionCheckpointResult> {
  const { discardSessionCheckpointDatabase, openRecoveryDatabase } = await sessionStorageIdb();
  if (!boundedString(scope, 256)) return { ok: false, removedKeys: [], reason: "invalid" };
  const database = await openRecoveryDatabase();
  const removedKeys = new Set<string>();
  if (database) {
    const outcome = await discardSessionCheckpointDatabase(database, scope, removedKeys);
    if (outcome.status === "protected") return { ok: false, removedKeys: outcome.protectedKeys, reason: "protected" };
    if (outcome.status !== "discarded") return { ok: false, removedKeys: [...removedKeys], reason: "unavailable" };
  } else {
    if (!lockHeld) return { ok: false, removedKeys: [], reason: "unavailable" };
    const registry = await readSessionRegistryInternal(Date.now());
    const protectedKeys = registry.registry.windows
      .filter((entry) => entry.dirtyRecoveryKeys.some((key) => sameRecoveryScope(key, scope)))
      .flatMap((entry) => entry.dirtyRecoveryKeys.filter((key) => sameRecoveryScope(key, scope)));
    if (protectedKeys.length) return { ok: false, removedKeys: [...new Set(protectedKeys)], reason: "protected" };
  }
  const storage = getStorageSafe();
  if (storage) {
    try {
      const checkpointKey = sessionCheckpointStorageKey(scope);
      if (storage.getItem(checkpointKey) !== null) storage.removeItem(checkpointKey);
      const entries = readFallbackRecoveryEntries(storage);
      for (const entry of entries) {
        if (entry.key === checkpointKey || sameRecoveryScope(entry.key, scope)) {
          removedKeys.add(entry.key);
          storage.removeItem(entry.key);
        }
      }
      writeFallbackRecoveryEntries(storage, readFallbackRecoveryEntries(storage));
    } catch {
      return { ok: false, removedKeys: [...removedKeys], reason: "unavailable" };
    }
  }
  return { ok: true, removedKeys: [...removedKeys] };
}

async function claimSessionWindowInternal(input: ClaimSessionWindowInput, lockHeld = false): Promise<ClaimSessionWindowResult> {
  const { openRecoveryDatabase } = await sessionStorageIdb();
  const candidates = await listRecoverableSessionCheckpointCandidates(input.workspace);
  const preferred = input.preferredScope ? candidates.find((candidate) => candidate.checkpoint.scope === input.preferredScope && candidate.completeMetadata
    && candidate.activeWindowIds.length === 0
    && (candidate.closedWindowIds.length > 0 || (input.allowStale === true && candidate.staleWindowIds.length > 0))) : undefined;
  const reusable = preferred ?? candidates.find((candidate) => candidate.completeMetadata
    && candidate.activeWindowIds.length === 0
    && (candidate.closedWindowIds.length > 0 || (input.allowStale === true && candidate.staleWindowIds.length > 0)));
  if (reusable) {
    const claimed = await claimRecoverableSessionCandidateInternal({
      windowId: input.windowId,
      workspace: input.workspace,
      candidate: { scope: reusable.checkpoint.scope, checkpointId: reusable.checkpoint.checkpointId, sequence: reusable.checkpoint.sequence },
      dirtyRecoveryKeys: input.dirtyRecoveryKeys,
      allowStale: input.allowStale,
      now: input.now,
    }, lockHeld);
    const { checkpoint: _checkpoint, ...claimResult } = claimed;
    return claimResult;
  }
  const database = await openRecoveryDatabase();
  const scope = input.windowId;
  const attached = await attachSessionWindowInternal({ ...input, scope, dirtyRecoveryKeys: [] }, false, lockHeld);
  if (database && attached.ok) await writeSessionRegistryFallback(attached.registry, lockHeld);
  return { ...attached, reusedScope: false };
}

async function claimRecoverableSessionCandidateInternal(input: ClaimRecoverableSessionCandidateInput, lockHeld = false): Promise<ClaimRecoverableSessionCandidateResult> {
  const unavailable: ClaimRecoverableSessionCandidateResult = { ok: false, lease: null, registry: emptySessionRegistry(), staleWindowIds: [], reusedScope: false, checkpoint: null, reason: "unavailable" };
  if (!boundedString(input.windowId, 256) || !boundedString(input.candidate.scope, 256) || typeof input.workspace !== "string" || input.workspace.length > MAX_PATH_LENGTH) {
    return { ...unavailable, reason: "invalid" };
  }
  const { claimRecoverableSessionWindowDatabase, openRecoveryDatabase } = await sessionStorageIdb();
  const database = await openRecoveryDatabase();
  let result: SessionRegistryResult;
  let checkpoint: SessionCheckpointMetadata | null = null;
  if (database) {
    const claimed = await claimRecoverableSessionWindowDatabase(database, input);
    result = claimed;
    checkpoint = claimed.checkpoint;
  } else {
    const storage = getStorageSafe();
    const claim = () => claimRecoverableSessionWindowFallback(input, true);
    const claimed = lockHeld ? await claim() : storage ? await withSessionFallbackLock(storage, claim) : false;
    if (claimed === false) return unavailable;
    result = claimed.result;
    checkpoint = claimed.checkpoint;
  }
  if (result.ok && database) await writeSessionRegistryFallback(result.registry, lockHeld);
  return {
    ...result,
    reusedScope: result.ok,
    checkpoint: result.ok ? checkpoint : null,
  };
}

async function claimRecoverableSessionWindowFallback(
  input: ClaimRecoverableSessionCandidateInput,
  lockHeld: boolean,
): Promise<{ result: SessionRegistryResult; checkpoint: SessionCheckpointMetadata | null }> {
  const fresh = await readSessionCheckpointMetadataFallback(input.candidate.scope);
  if (!fresh?.completeMetadata
    || fresh.checkpoint.checkpointId !== input.candidate.checkpointId
    || fresh.checkpoint.sequence !== input.candidate.sequence
    || fresh.checkpoint.session.workspace !== input.workspace) {
    return { result: { ok: false, lease: null, registry: emptySessionRegistry(), staleWindowIds: [], reason: "conflict" }, checkpoint: null };
  }
  const now = nonNegativeTimestamp(input.now) ?? Date.now();
  const registry = await readSessionRegistryInternal(now);
  const scopeWindows = registry.registry.windows.filter((entry) => entry.scope === input.candidate.scope && entry.workspace === input.workspace);
  const activeWindows = scopeWindows.filter((entry) => entry.status === "open" && now - entry.heartbeatAt <= SESSION_WINDOW_LEASE_MS);
  const staleWindows = scopeWindows.filter((entry) => entry.status === "open" && now - entry.heartbeatAt > SESSION_WINDOW_LEASE_MS);
  const closedWindows = scopeWindows.filter((entry) => entry.status === "closed");
  if (activeWindows.length || (!closedWindows.length && !(input.allowStale && staleWindows.length))) {
    return { result: { ok: false, lease: null, registry: registry.registry, staleWindowIds: registry.staleWindowIds, reason: "conflict" }, checkpoint: null };
  }
  const dirtyRecoveryKeys = fresh.checkpoint.session.tabs.filter((tab) => tab.dirty).map((tab) => recoveryStorageKey(tab.id, fresh.checkpoint.scope));
  const attached = await attachSessionWindowInternal({
    windowId: input.windowId,
    scope: fresh.checkpoint.scope,
    workspace: input.workspace,
    dirtyRecoveryKeys: [...dirtyRecoveryKeys, ...(input.dirtyRecoveryKeys ?? [])],
    now: input.now,
  }, Boolean(input.allowStale && staleWindows.length), lockHeld);
  return { result: attached, checkpoint: attached.ok ? fresh.checkpoint : null };
}

async function attachSessionWindowInternal(input: AttachSessionWindowInput, takeOverStaleScope = false, lockHeld = false): Promise<SessionRegistryResult> {
  const { mutateSessionRegistryDatabase, openRecoveryDatabase } = await sessionStorageIdb();
  if (!boundedString(input.windowId, 256) || !boundedString(input.scope, 256) || typeof input.workspace !== "string" || input.workspace.length > MAX_PATH_LENGTH) {
    return { ok: false, lease: null, registry: emptySessionRegistry(), staleWindowIds: [], reason: "invalid" };
  }
  const now = nonNegativeTimestamp(input.now) ?? Date.now();
  const lease: SessionWindowLease = { windowId: input.windowId, scope: input.scope, leaseId: makeSessionId() };
  const database = await openRecoveryDatabase();
  const mutate = (current: SessionRegistry): SessionRegistry | null => {
    const liveOwner = current.windows.find((entry) => entry.scope === input.scope
      && entry.status === "open"
      && !(takeOverStaleScope && now - entry.heartbeatAt > SESSION_WINDOW_LEASE_MS)
      && entry.windowId !== input.windowId);
    if (liveOwner) return null;
    const record: SessionRegistry["windows"][number] = {
      ...lease,
      workspace: input.workspace,
      attachedAt: now,
      heartbeatAt: now,
      dirtyRecoveryKeys: [...new Set((input.dirtyRecoveryKeys ?? []).filter(isRecoveryStorageKey))],
      status: "open",
    };
    const windows = current.windows
      .filter((entry) => entry.windowId !== input.windowId)
      .map((entry) => takeOverStaleScope
        && entry.scope === input.scope
        && entry.status === "open"
        && now - entry.heartbeatAt > SESSION_WINDOW_LEASE_MS
        ? { ...entry, status: "closed" as const, closedAt: now, heartbeatAt: now }
        : entry);
    const boundedWindows = compactSessionWindows([...windows, record]);
    if (!boundedWindows) return null;
    return { version: SESSION_REGISTRY_SCHEMA_VERSION, revision: current.revision + 1, updatedAt: now, windows: boundedWindows };
  };
  const fallbackRegistry = parseSessionRegistry(readStorage(SESSION_REGISTRY_STORAGE_KEY));
  const databaseResult = database ? await mutateSessionRegistryDatabase(database, mutate, fallbackRegistry) : { registry: emptySessionRegistry(), saved: false };
  const databaseConflict = Boolean(database && databaseResult.registry.windows.some((entry) => entry.scope === input.scope && entry.status === "open" && entry.windowId !== input.windowId));
  const fallbackResult = database && databaseResult.saved
    ? { registry: databaseResult.registry, saved: await writeSessionRegistryFallback(databaseResult.registry, lockHeld) }
    : databaseConflict
      ? { registry: databaseResult.registry, saved: false }
      : await mutateSessionRegistryFallback(mutate, lockHeld);
  const registry = databaseResult.saved ? databaseResult.registry : fallbackResult.registry;
  const ok = databaseResult.saved || fallbackResult.saved;
  const liveOwner = registry.windows.some((entry) => entry.scope === input.scope && entry.status === "open" && entry.windowId !== input.windowId);
  const capacityReached = registry.windows.length >= MAX_SESSION_WINDOWS && !liveOwner;
  return {
    ok,
    lease: ok ? lease : null,
    registry,
    staleWindowIds: registry.windows.filter((entry) => entry.status === "open" && now - entry.heartbeatAt > SESSION_WINDOW_LEASE_MS).map((entry) => entry.windowId),
    ...(ok ? {} : { reason: liveOwner ? "conflict" as const : capacityReached ? "capacity" as const : "unavailable" as const }),
  };
}

async function updateSessionWindowInternal(lease: SessionWindowLease, dirtyRecoveryKeys: readonly string[] | undefined, now: number, lockHeld = false): Promise<SessionRegistryUpdateResult> {
  const { mutateSessionRegistryDatabase, openRecoveryDatabase } = await sessionStorageIdb();
  const database = await openRecoveryDatabase();
  let openLeaseObserved = false;
  const mutate = (current: SessionRegistry): SessionRegistry | null => {
    const record = current.windows.find((entry) => sameSessionLease(entry, lease) && entry.status === "open");
    if (!record) return null;
    openLeaseObserved = true;
    const nextRecord: SessionRegistry["windows"][number] = { ...record, heartbeatAt: now, dirtyRecoveryKeys: dirtyRecoveryKeys ? [...new Set(dirtyRecoveryKeys.filter(isRecoveryStorageKey))] : record.dirtyRecoveryKeys };
    return { version: SESSION_REGISTRY_SCHEMA_VERSION, revision: current.revision + 1, updatedAt: now, windows: current.windows.map((entry) => sameSessionLease(entry, lease) ? nextRecord : entry) };
  };
  const fallbackRead = readSessionRegistryFallback();
  const fallbackRegistry = fallbackRead.readSucceeded ? fallbackRead.registry : null;
  const databaseResult = database ? await mutateSessionRegistryDatabase(database, mutate, fallbackRegistry) : { registry: emptySessionRegistry(), saved: false, readSucceeded: false };
  const fallbackResult = database && databaseResult.saved
    ? { registry: databaseResult.registry, saved: await writeSessionRegistryFallback(databaseResult.registry, lockHeld), readSucceeded: fallbackRead.readSucceeded }
    : await mutateSessionRegistryFallback(mutate, lockHeld);
  const ok = databaseResult.saved || fallbackResult.saved;
  const registry = databaseResult.saved ? databaseResult.registry : fallbackResult.registry;
  const registryReadSucceeded = database
    ? databaseResult.readSucceeded && fallbackRead.readSucceeded && fallbackResult.readSucceeded
    : fallbackResult.readSucceeded;
  const reason = registryReadSucceeded && !openLeaseObserved ? "stale-lease" as const : "unavailable" as const;
  return { ok, registry, ...(ok ? {} : { reason }) };
}

async function closeSessionWindowInternal(lease: SessionWindowLease, options: { discardRecovery?: boolean; now?: number }, lockHeld = false): Promise<SessionRegistryUpdateResult> {
  const { mutateSessionRegistryDatabase, openRecoveryDatabase } = await sessionStorageIdb();
  const now = nonNegativeTimestamp(options.now) ?? Date.now();
  const database = await openRecoveryDatabase();
  let openLeaseObserved = false;
  const mutate = (current: SessionRegistry): SessionRegistry | null => {
    const record = current.windows.find((entry) => sameSessionLease(entry, lease));
    if (!record) return null;
    openLeaseObserved = record.status === "open";
    const otherOpenOwner = current.windows.some((entry) => entry.scope === lease.scope && entry.status === "open" && !sameSessionLease(entry, lease));
    const keepClosedDirtyRecord = !options.discardRecovery && record.dirtyRecoveryKeys.length > 0;
    let windows = keepClosedDirtyRecord
      ? current.windows.map((entry) => sameSessionLease(entry, lease) ? { ...entry, status: "closed" as const, closedAt: now, heartbeatAt: now } : entry)
      : current.windows.filter((entry) => !sameSessionLease(entry, lease));
    if (options.discardRecovery && !otherOpenOwner) {
      windows = windows.filter((entry) => !(entry.scope === lease.scope && entry.status === "closed" && entry.dirtyRecoveryKeys.length > 0));
    }
    return { version: SESSION_REGISTRY_SCHEMA_VERSION, revision: current.revision + 1, updatedAt: now, windows };
  };
  const fallbackRead = readSessionRegistryFallback();
  const fallbackRegistry = fallbackRead.readSucceeded ? fallbackRead.registry : null;
  const databaseResult = database ? await mutateSessionRegistryDatabase(database, mutate, fallbackRegistry) : { registry: emptySessionRegistry(), saved: false, readSucceeded: false };
  const fallbackResult = database && databaseResult.saved
    ? { registry: databaseResult.registry, saved: await writeSessionRegistryFallback(databaseResult.registry, lockHeld), readSucceeded: fallbackRead.readSucceeded }
    : await mutateSessionRegistryFallback(mutate, lockHeld);
  const ok = databaseResult.saved || fallbackResult.saved;
  const registry = databaseResult.saved ? databaseResult.registry : fallbackResult.registry;
  const registryReadSucceeded = database
    ? databaseResult.readSucceeded && fallbackRead.readSucceeded && fallbackResult.readSucceeded
    : fallbackResult.readSucceeded;
  const reason = registryReadSucceeded && !openLeaseObserved ? "stale-lease" as const : "unavailable" as const;
  return { ok, registry, ...(ok ? {} : { reason }) };
}

async function readSessionRegistryInternal(now: number): Promise<{ registry: SessionRegistry; staleWindowIds: string[] }> {
  const { openRecoveryDatabase, readSessionRegistryDatabase } = await sessionStorageIdb();
  const database = await openRecoveryDatabase();
  const [databaseRegistry, fallbackRegistry] = await Promise.all([
    database ? readSessionRegistryDatabase(database) : Promise.resolve(null),
    Promise.resolve(parseSessionRegistry(readStorage(SESSION_REGISTRY_STORAGE_KEY))),
  ]);
  const registry = databaseRegistry && fallbackRegistry
    ? mergeSessionRegistries(databaseRegistry, fallbackRegistry)
    : databaseRegistry ?? fallbackRegistry ?? emptySessionRegistry();
  const staleWindowIds = registry.windows.filter((entry) => entry.status === "open" && now - entry.heartbeatAt > SESSION_WINDOW_LEASE_MS).map((entry) => entry.windowId);
  return { registry, staleWindowIds };
}

export {
  CURSOR_STORAGE_KEY,
  MAX_RECOVERY_BYTES,
  MAX_RECOVERY_TOTAL_BYTES,
  RECOVERY_STORAGE_PREFIX,
  SESSION_CHECKPOINT_SCHEMA_VERSION,
  SESSION_CHECKPOINT_STORAGE_PREFIX,
  SESSION_REGISTRY_SCHEMA_VERSION,
  SESSION_REGISTRY_STORAGE_KEY,
  SESSION_SCHEMA_VERSION,
  SESSION_STORAGE_KEY,
  SESSION_WINDOW_LEASE_MS,
} from "./session-storage-schema";
export type {
  AttachSessionWindowInput,
  ClaimSessionWindowInput,
  ClaimSessionWindowResult,
  ClaimRecoverableSessionCandidateInput,
  ClaimRecoverableSessionCandidateResult,
  CursorPosition,
  DiscardSessionCheckpointResult,
  PersistedTab,
  RecoverableSession,
  RecoverableSessionCandidate,
  RecoveryBaseline,
  RecoverySnapshot,
  RecoveryStorageUsage,
  RecoveryStorageValue,
  RecoveryWriteOptions,
  SessionCheckpoint,
  SessionCheckpointMetadata,
  SessionCheckpointMetadataReadResult,
  SessionCheckpointDurability,
  SessionCheckpointInput,
  SessionCheckpointReadResult,
  SessionCheckpointResult,
  SessionMetadata,
  SessionRegistry,
  SessionRegistryResult,
  SessionRegistryUpdateResult,
  SessionWindowLease,
  SessionWindowRecord,
} from "./session-storage-schema";
export {
  baselineKeyForRecoveryKey,
  collectExpandedPaths,
  compactRecoverySnapshot,
  createSessionMetadata,
  isRecoveryBaselineKey,
  parseCursorPositions,
  parseRecovery,
  parseRecoveryBaseline,
  parseSession,
  parseSessionCheckpoint,
  parseSessionCheckpointMetadata,
  parseSessionRegistry,
  recoveryBaselineKey,
  recoveryBaselineSizeBytes,
  recoveryKeyForBaselineKey,
  recoverySnapshotSizeBytes,
  recoverySnapshotStorageValue,
  recoveryStorageKey,
  resolveRecoveryBaseline,
  retainSessionTabs,
  sameRecoveryStorageScope,
  scopedStorageKey,
  serializeCursorPositions,
  sessionCheckpointStorageKey,
  sessionCheckpointMetadataStorageKey,
} from "./session-storage-schema";
export { readStorage, removeStorage, writeStorage } from "./session-storage-fallback";
