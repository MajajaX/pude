import {
  MAX_RECOVERY_BYTES,
  MAX_RECOVERY_TOTAL_BYTES,
  recoverySnapshotSizeBytes,
  RECOVERY_STORAGE_PREFIX,
  SESSION_CHECKPOINT_STORAGE_PREFIX,
  SESSION_CHECKPOINT_METADATA_STORAGE_PREFIX,
  SESSION_REGISTRY_STORAGE_KEY,
  compareSessionCheckpoints,
  emptySessionRegistry,
  isPersistedRecoveryKey,
  isRecord,
  isRecoveryStorageKey,
  isSessionCheckpointStorageKey,
  nonNegativeInteger,
  nonNegativeTimestamp,
  parseJson,
  parseSessionCheckpoint,
  parseSessionCheckpointMetadata,
  parseSessionRegistry,
  sameRecoveryScope,
  sameSessionLease,
  sessionCheckpointStatus,
  sessionCheckpointStorageKey,
  sessionCheckpointMetadataStorageKey,
  utf8ByteLength,
  type RecoverySnapshot,
  type SessionCheckpoint,
  type SessionCheckpointReadResult,
  type SessionCheckpointMetadata,
  type SessionCheckpointMetadataReadResult,
  type SessionRegistry,
  type SessionWindowLease,
} from "./session-storage-schema";
import { SESSION_GLOBAL_OPERATION_LOCK_KEY, withSessionLock } from "./session-storage-locks";
import { readStorage } from "./session-storage-basic";
export { readStorage, removeStorage, writeStorage } from "./session-storage-basic";

const RECOVERY_FALLBACK_INDEX_KEY = `${RECOVERY_STORAGE_PREFIX}index`;
const SESSION_FALLBACK_LOCK_KEY = SESSION_GLOBAL_OPERATION_LOCK_KEY;
const MAX_FALLBACK_INDEX_ENTRIES = 256;
export const MAX_FALLBACK_RECOVERY_BYTES = 4 * 1024 * 1024;
export const MAX_FALLBACK_CHECKPOINT_BYTES = 4 * 1024 * 1024;

type FallbackRecoveryEntry = {
  key: string;
  bytes: number;
  updatedAt: number;
};

export function getStorageSafe(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readSessionRegistryFallback(): { registry: SessionRegistry; readSucceeded: boolean } {
  const storage = getStorageSafe();
  if (!storage) return { registry: emptySessionRegistry(), readSucceeded: false };
  try {
    const raw = storage.getItem(SESSION_REGISTRY_STORAGE_KEY);
    if (raw === null) return { registry: emptySessionRegistry(), readSucceeded: true };
    const registry = parseSessionRegistry(raw);
    return registry
      ? { registry, readSucceeded: true }
      : { registry: emptySessionRegistry(), readSucceeded: false };
  } catch {
    return { registry: emptySessionRegistry(), readSucceeded: false };
  }
}

export function readFallbackRecoveryEntries(storage: Storage | null): FallbackRecoveryEntry[] {
  if (!storage) return [];
  const entries = new Map<string, FallbackRecoveryEntry>();
  try {
    const rawIndex = storage.getItem(RECOVERY_FALLBACK_INDEX_KEY);
    const value = rawIndex ? parseJson(rawIndex) : null;
    if (Array.isArray(value)) {
      for (const candidate of value) {
        if (!isRecord(candidate) || typeof candidate.key !== "string" || !isPersistedRecoveryKey(candidate.key) || candidate.key === RECOVERY_FALLBACK_INDEX_KEY) continue;
        const bytes = nonNegativeInteger(candidate.bytes);
        const updatedAt = nonNegativeTimestamp(candidate.updatedAt);
        if (bytes === undefined || updatedAt === undefined) continue;
        entries.set(candidate.key, { key: candidate.key, bytes, updatedAt });
      }
    }
    // A valid index is updated with every fallback write. Trust it on the
    // normal path so budgeting a one-file write never reads every recovery
    // body from localStorage. The scan below migrates old installations once.
    if (Array.isArray(value)) return [...entries.values()];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || key === RECOVERY_FALLBACK_INDEX_KEY || !isPersistedRecoveryKey(key)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const existing = entries.get(key);
      entries.set(key, { key, bytes: utf8ByteLength(raw), updatedAt: existing?.updatedAt ?? 0 });
    }
  } catch {
    return [...entries.values()];
  }
  return [...entries.values()];
}

export function writeFallbackRecoveryEntries(storage: Storage, entries: FallbackRecoveryEntry[]): void {
  const bounded = entries
    .filter((entry) => isPersistedRecoveryKey(entry.key) && entry.key !== RECOVERY_FALLBACK_INDEX_KEY)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_FALLBACK_INDEX_ENTRIES);
  try {
    storage.setItem(RECOVERY_FALLBACK_INDEX_KEY, JSON.stringify(bounded));
  } catch {
    // The snapshot itself is still useful if the small bookkeeping record cannot fit.
  }
}

export async function writeRecoveryFallback(
  key: string,
  snapshot: RecoverySnapshot,
  protectedRecoveryKeys = new Set<string>(),
  maxBytes = MAX_RECOVERY_TOTAL_BYTES,
  lockHeld = false,
): Promise<boolean> {
  const storage = getStorageSafe();
  if (!storage) return false;
  const operation = () => writeRecoveryFallbackUnlocked(storage, key, snapshot, protectedRecoveryKeys, maxBytes);
  const result = lockHeld ? operation() : await withSessionFallbackLock(storage, operation);
  return result === true;
}

function writeRecoveryFallbackUnlocked(storage: Storage, key: string, snapshot: RecoverySnapshot, protectedRecoveryKeys = new Set<string>(), maxBytes = MAX_RECOVERY_TOTAL_BYTES): boolean {
  const estimatedBytes = recoverySnapshotSizeBytes(snapshot);
  if (estimatedBytes > MAX_RECOVERY_BYTES || estimatedBytes > MAX_FALLBACK_RECOVERY_BYTES || estimatedBytes > maxBytes) return false;
  let serialized: string;
  try {
    serialized = JSON.stringify(snapshot);
  } catch {
    return false;
  }
  const serializedBytes = utf8ByteLength(serialized);
  if (serializedBytes > MAX_RECOVERY_BYTES || serializedBytes > MAX_FALLBACK_RECOVERY_BYTES || serializedBytes > maxBytes) return false;
  try {
    const entries = readFallbackRecoveryEntries(storage);
    const existing = entries.find((entry) => entry.key === key);
    let projectedBytes = entries.reduce((total, entry) => total + entry.bytes, 0) - (existing?.bytes ?? 0) + serializedBytes;
    const evicted: FallbackRecoveryEntry[] = [];
    if (projectedBytes > maxBytes) {
      const candidates = entries
        .filter((entry) => entry.key !== key && !protectedRecoveryKeys.has(entry.key) && !fallbackEntryProtected(entry, protectedRecoveryKeys, storage))
        .sort((left, right) => left.updatedAt - right.updatedAt);
      for (const candidate of candidates) {
        if (projectedBytes <= maxBytes) break;
        evicted.push(candidate);
        projectedBytes -= candidate.bytes;
      }
    }
    if (projectedBytes > maxBytes) return false;
    // Keep the old copy until the replacement has been accepted by storage.
    storage.setItem(key, serialized);
    for (const candidate of evicted) storage.removeItem(candidate.key);
    const nextEntries = readFallbackRecoveryEntries(storage).filter((entry) => entry.key !== key);
    nextEntries.push({ key, bytes: serializedBytes, updatedAt: Date.now() });
    writeFallbackRecoveryEntries(storage, nextEntries);
    return true;
  } catch {
    return false;
  }
}

export async function removeRecoveryFallback(key: string, lockHeld = false): Promise<void> {
  const storage = getStorageSafe();
  if (!storage) return;
  const operation = () => {
    try {
      storage.removeItem(key);
      writeFallbackRecoveryEntries(storage, readFallbackRecoveryEntries(storage).filter((entry) => entry.key !== key));
    } catch {
      // Storage can be unavailable in private or restricted WebViews.
    }
  };
  if (lockHeld) {
    operation();
    return;
  }
  await withSessionFallbackLock(storage, operation);
}

export async function readSessionCheckpointFallback(scope: string): Promise<SessionCheckpointReadResult | null> {
  const raw = readStorage(sessionCheckpointStorageKey(scope));
  const checkpoint = parseSessionCheckpoint(raw);
  return checkpoint?.scope === scope ? sessionCheckpointStatus(checkpoint, "fallback") : null;
}

/** Reads only the serialized byte count, for bounded fallback preflight. */
export function readSessionCheckpointFallbackBytes(scope: string): number | null {
  const raw = readStorage(sessionCheckpointStorageKey(scope));
  return raw === null ? 0 : utf8ByteLength(raw);
}

export async function readSessionCheckpointMetadataFallback(scope: string): Promise<SessionCheckpointMetadataReadResult | null> {
  const raw = readStorage(sessionCheckpointMetadataStorageKey(scope));
  const value = raw ? parseJson(raw) : null;
  const recoveryKeys = isRecord(value) && Array.isArray(value.recoveryKeys) ? value.recoveryKeys : undefined;
  const parsed = parseSessionCheckpointMetadata(value, recoveryKeys, "fallback");
  if (parsed?.checkpoint.scope === scope) return parsed;
  // Compatibility path for checkpoints written before metadata sidecars.
  const legacy = await readSessionCheckpointFallback(scope);
  return legacy ? parseSessionCheckpointMetadata(legacy.checkpoint, Object.keys(legacy.checkpoint.recoveries), "fallback") : null;
}

/** Reads only metadata sidecars for new checkpoints; legacy bodies are parsed once when no sidecar exists. */
export async function readAllSessionCheckpointMetadataFallback(workspace?: string): Promise<SessionCheckpointMetadataReadResult[]> {
  const storage = getStorageSafe();
  if (!storage) return [];
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && (key.startsWith(SESSION_CHECKPOINT_METADATA_STORAGE_PREFIX) || key.startsWith(SESSION_CHECKPOINT_STORAGE_PREFIX))) keys.push(key);
  }
  const byScope = new Map<string, SessionCheckpointMetadataReadResult>();
  for (const key of keys) {
    if (!key.startsWith(SESSION_CHECKPOINT_METADATA_STORAGE_PREFIX)) continue;
    const raw = readStorage(key);
    const value = raw ? parseJson(raw) : null;
    const recoveryKeys = isRecord(value) && Array.isArray(value.recoveryKeys) ? value.recoveryKeys : undefined;
    const candidate = parseSessionCheckpointMetadata(value, recoveryKeys, "fallback");
    if (candidate && (workspace === undefined || candidate.checkpoint.session.workspace === workspace)) byScope.set(candidate.checkpoint.scope, candidate);
  }
  for (const key of keys) {
    if (!key.startsWith(SESSION_CHECKPOINT_STORAGE_PREFIX)) continue;
    const raw = readStorage(key);
    const legacy = parseSessionCheckpoint(raw);
    if (!legacy || byScope.has(legacy.scope) || (workspace !== undefined && legacy.session.workspace !== workspace)) continue;
    const candidate = parseSessionCheckpointMetadata(legacy, Object.keys(legacy.recoveries), "fallback");
    if (candidate) byScope.set(candidate.checkpoint.scope, candidate);
  }
  return [...byScope.values()];
}

export function writeSessionCheckpointMetadataFallback(checkpoint: SessionCheckpointMetadata): boolean {
  const storage = getStorageSafe();
  if (!storage) return false;
  try {
    const entries = readFallbackRecoveryEntries(storage);
    const serialized = JSON.stringify(checkpoint);
    if (utf8ByteLength(serialized) > 1024 * 1024) return false;
    const key = sessionCheckpointMetadataStorageKey(checkpoint.scope);
    storage.setItem(key, serialized);
    writeFallbackRecoveryEntries(storage, entries.filter((entry) => entry.key !== key).concat({ key, bytes: utf8ByteLength(serialized), updatedAt: checkpoint.committedAt }));
    return true;
  } catch {
    return false;
  }
}

export function removeSessionCheckpointBodyFallback(scope: string): void {
  const storage = getStorageSafe();
  try {
    if (!storage) return;
    const key = sessionCheckpointStorageKey(scope);
    storage.removeItem(key);
    writeFallbackRecoveryEntries(storage, readFallbackRecoveryEntries(storage).filter((entry) => entry.key !== key));
  } catch {
    // localStorage may be unavailable in restricted WebViews.
  }
}

export async function readAllSessionCheckpointsFallback(): Promise<SessionCheckpointReadResult[]> {
  const storage = getStorageSafe();
  if (!storage) return [];
  const results: SessionCheckpointReadResult[] = [];
  for (const entry of readFallbackRecoveryEntries(storage)) {
    if (!isSessionCheckpointStorageKey(entry.key)) continue;
    const checkpoint = parseSessionCheckpoint(storage.getItem(entry.key));
    if (checkpoint) results.push(sessionCheckpointStatus(checkpoint, "fallback"));
  }
  return results;
}

export async function writeSessionCheckpointFallback(
  checkpoint: SessionCheckpoint,
  protectedRecoveryKeys: Set<string>,
  maxBytes: number,
  estimateBytes: number,
  serializeCheckpoint: () => string,
  lease?: SessionWindowLease,
  lockHeld = false,
): Promise<{ saved: boolean; skipped: boolean; evictedKeys: string[] }> {
  const storage = getStorageSafe();
  if (!storage) return { saved: false, skipped: true, evictedKeys: [] };
  const operation = () => {
    const fallbackRegistry = parseSessionRegistry(storage.getItem(SESSION_REGISTRY_STORAGE_KEY));
    const liveOwner = fallbackRegistry?.windows.find((entry) => entry.scope === checkpoint.scope && entry.status === "open");
    if (liveOwner && (!lease || !sameSessionLease(liveOwner, lease))) return { saved: false, skipped: false, evictedKeys: [] };
    if (lease && !fallbackLeaseIsOpen(storage, lease)) return { saved: false, skipped: false, evictedKeys: [] };
    const existing = parseSessionCheckpoint(storage.getItem(sessionCheckpointStorageKey(checkpoint.scope)));
    if (existing && compareSessionCheckpoints(existing, checkpoint) >= 0) return { saved: false, skipped: true, evictedKeys: [] };
    return writeSessionCheckpointFallbackUnlocked(storage, checkpoint, protectedRecoveryKeys, maxBytes, estimateBytes, serializeCheckpoint);
  };
  const result = lockHeld ? operation() : await withSessionFallbackLock(storage, operation);
  return result === false ? { saved: false, skipped: true, evictedKeys: [] } : result;
}

function writeSessionCheckpointFallbackUnlocked(
  storage: Storage,
  checkpoint: SessionCheckpoint,
  protectedRecoveryKeys: Set<string>,
  maxBytes: number,
  estimateBytes: number,
  serializeCheckpoint: () => string,
): { saved: boolean; skipped: boolean; evictedKeys: string[] } {
  const key = sessionCheckpointStorageKey(checkpoint.scope);
  const metadataKey = sessionCheckpointMetadataStorageKey(checkpoint.scope);
  const metadataValue: SessionCheckpointMetadata = {
    version: checkpoint.version,
    scope: checkpoint.scope,
    checkpointId: checkpoint.checkpointId,
    sequence: checkpoint.sequence,
    committedAt: checkpoint.committedAt,
    session: checkpoint.session,
    recoveryRevisions: checkpoint.recoveryRevisions,
    recoveryKeys: Object.keys(checkpoint.recoveries),
  };
  let serializedMetadata: string;
  try { serializedMetadata = JSON.stringify(metadataValue); } catch { return { saved: false, skipped: false, evictedKeys: [] }; }
  const estimatedTotalBytes = estimateBytes + utf8ByteLength(serializedMetadata);
  if (estimatedTotalBytes > maxBytes) return { saved: false, skipped: true, evictedKeys: [] };
  const entries = readFallbackRecoveryEntries(storage);
  const existing = entries.find((entry) => entry.key === key);
  const existingMetadata = entries.find((entry) => entry.key === metadataKey);
  let projectedBytes = entries.reduce((total, entry) => total + entry.bytes, 0) - (existing?.bytes ?? 0) - (existingMetadata?.bytes ?? 0) + estimatedTotalBytes;
  const candidates = entries
    .filter((entry) => entry.key !== key && !fallbackEntryProtectedForCheckpoint(entry, checkpoint, protectedRecoveryKeys, storage))
    .sort((left, right) => left.updatedAt - right.updatedAt);
  const evictedKeys: string[] = [];
  const evictedEntries: FallbackRecoveryEntry[] = [];
  for (const candidate of candidates) {
    if (projectedBytes <= maxBytes) break;
    projectedBytes -= candidate.bytes;
    evictedEntries.push(candidate);
    evictedKeys.push(...fallbackEntryRecoveryKeys(candidate, storage));
  }
  if (projectedBytes > maxBytes) return { saved: false, skipped: true, evictedKeys: [] };
  let serializedCheckpoint: string;
  try {
    serializedCheckpoint = serializeCheckpoint();
  } catch {
    return { saved: false, skipped: false, evictedKeys: [] };
  }
  const bytes = utf8ByteLength(serializedCheckpoint);
  const exactBytes = bytes + utf8ByteLength(serializedMetadata);
  if (exactBytes > maxBytes || projectedBytes - estimatedTotalBytes + exactBytes > maxBytes) return { saved: false, skipped: true, evictedKeys: [] };
  const previousCheckpoint = storage.getItem(key);
  const previousMetadata = storage.getItem(metadataKey);
  try {
    // Write the new complete checkpoint before deleting any old entry. A quota
    // failure therefore leaves the previous complete marker available.
    storage.setItem(key, serializedCheckpoint);
    storage.setItem(metadataKey, serializedMetadata);
    for (const candidate of evictedEntries) storage.removeItem(candidate.key);
    // A checkpoint supersedes legacy per-tab fallback copies for this scope.
    for (const candidate of readFallbackRecoveryEntries(storage)) {
      if (candidate.key === key || !sameRecoveryScope(candidate.key, checkpoint.scope)) continue;
      if (checkpoint.recoveryRevisions[candidate.key] !== undefined || !fallbackEntryProtected(candidate, protectedRecoveryKeys, storage)) storage.removeItem(candidate.key);
    }
    const nextEntries = readFallbackRecoveryEntries(storage).filter((entry) => entry.key !== key && entry.key !== metadataKey);
    nextEntries.push({ key, bytes, updatedAt: checkpoint.committedAt }, { key: metadataKey, bytes: utf8ByteLength(serializedMetadata), updatedAt: checkpoint.committedAt });
    writeFallbackRecoveryEntries(storage, nextEntries);
    return { saved: true, skipped: false, evictedKeys: [...new Set(evictedKeys)] };
  } catch {
    try {
      if (previousCheckpoint === null) storage.removeItem(key);
      else storage.setItem(key, previousCheckpoint);
      if (previousMetadata === null) storage.removeItem(metadataKey);
      else storage.setItem(metadataKey, previousMetadata);
    } catch {
      // Preserve the original write failure result; the app will report that
      // this fallback did not commit.
    }
    return { saved: false, skipped: false, evictedKeys: [] };
  }
}

function fallbackEntryProtected(entry: FallbackRecoveryEntry, protectedRecoveryKeys: Set<string>, storage: Storage): boolean {
  if (protectedRecoveryKeys.has(entry.key)) return true;
  if (!entry.key.startsWith(SESSION_CHECKPOINT_STORAGE_PREFIX)) return false;
  const raw = storage.getItem(entry.key);
  const checkpoint = parseSessionCheckpoint(raw);
  return Boolean(checkpoint && Object.keys(checkpoint.recoveries).some((key) => protectedRecoveryKeys.has(key)));
}

function fallbackEntryProtectedForCheckpoint(entry: FallbackRecoveryEntry, checkpoint: SessionCheckpoint, protectedRecoveryKeys: Set<string>, storage: Storage): boolean {
  if (isRecoveryStorageKey(entry.key) && checkpoint.recoveryRevisions[entry.key] !== undefined) return false;
  return fallbackEntryProtected(entry, protectedRecoveryKeys, storage);
}

function fallbackEntryRecoveryKeys(entry: FallbackRecoveryEntry, storage: Storage): string[] {
  if (entry.key.startsWith(RECOVERY_STORAGE_PREFIX)) return [entry.key];
  const checkpoint = parseSessionCheckpoint(storage.getItem(entry.key));
  return checkpoint ? Object.keys(checkpoint.recoveries) : [];
}

export async function mutateSessionRegistryFallback(mutate: (current: SessionRegistry) => SessionRegistry | null, lockHeld = false): Promise<{ registry: SessionRegistry; saved: boolean; readSucceeded: boolean }> {
  const storage = getStorageSafe();
  if (!storage) return { registry: emptySessionRegistry(), saved: false, readSucceeded: false };
  const operation = () => {
    let raw: string | null;
    try {
      raw = storage.getItem(SESSION_REGISTRY_STORAGE_KEY);
    } catch {
      return { registry: emptySessionRegistry(), saved: false, readSucceeded: false };
    }
    const current = raw === null ? emptySessionRegistry() : parseSessionRegistry(raw);
    if (!current) return { registry: emptySessionRegistry(), saved: false, readSucceeded: false };
    let registry: SessionRegistry | null;
    try {
      registry = mutate(current);
    } catch {
      return { registry: current, saved: false, readSucceeded: false };
    }
    if (!registry) return { registry: current, saved: false, readSucceeded: true };
    try {
      storage.setItem(SESSION_REGISTRY_STORAGE_KEY, JSON.stringify(registry));
      return { registry, saved: true, readSucceeded: true };
    } catch {
      return { registry: current, saved: false, readSucceeded: true };
    }
  };
  try {
    const result = lockHeld ? operation() : await withSessionFallbackLock(storage, operation);
    return result === false ? { registry: emptySessionRegistry(), saved: false, readSucceeded: false } : result;
  } catch {
    return { registry: emptySessionRegistry(), saved: false, readSucceeded: false };
  }
}

export async function writeSessionRegistryFallback(registry: SessionRegistry, lockHeld = false): Promise<boolean> {
  const storage = getStorageSafe();
  if (!storage) return false;
  let serialized: string;
  try {
    serialized = JSON.stringify(registry);
  } catch {
    return false;
  }
  const operation = () => {
    const current = parseSessionRegistry(storage.getItem(SESSION_REGISTRY_STORAGE_KEY));
    if (current && current.revision >= registry.revision) return true;
    storage.setItem(SESSION_REGISTRY_STORAGE_KEY, serialized);
    return true;
  };
  const result = lockHeld ? operation() : await withSessionFallbackLock(storage, operation);
  return result === true;
}

function fallbackLeaseIsOpen(storage: Storage, lease: SessionWindowLease): boolean {
  const registry = parseSessionRegistry(storage.getItem(SESSION_REGISTRY_STORAGE_KEY));
  return Boolean(registry?.windows.some((entry) => sameSessionLease(entry, lease) && entry.status === "open"));
}

export async function withSessionFallbackLock<T>(storage: Storage, operation: () => T | Promise<T>): Promise<T | false> {
  void storage;
  return withSessionLock(SESSION_FALLBACK_LOCK_KEY, operation);
}
