import { setRecoveryDatabaseBlockedHandler as setBlockedHandler } from "./recovery-database-status";
import type * as SessionStorageRuntime from "./session-storage-runtime";

type Runtime = typeof SessionStorageRuntime;

let sessionStorageRuntimePromise: Promise<Runtime> | undefined;

function loadSessionStorageRuntime(): Promise<Runtime> {
  if (sessionStorageRuntimePromise) return sessionStorageRuntimePromise;
  const pending = import("./session-storage-runtime").catch((error: unknown) => {
    if (sessionStorageRuntimePromise === pending) sessionStorageRuntimePromise = undefined;
    throw error;
  });
  sessionStorageRuntimePromise = pending;
  return pending;
}

/**
 * Async persistence APIs share one lazily loaded implementation. Its queue
 * remains inside that single module instance, so back-to-back writes and
 * flushes preserve their existing ordering.
 */
export function readRecoveryStorage(...args: Parameters<Runtime["readRecoveryStorage"]>): ReturnType<Runtime["readRecoveryStorage"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.readRecoveryStorage(...args));
}

export function readRecoveryStorageResult(...args: Parameters<Runtime["readRecoveryStorageResult"]>): ReturnType<Runtime["readRecoveryStorageResult"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.readRecoveryStorageResult(...args));
}

export function readRecoveryBaselineStorage(...args: Parameters<Runtime["readRecoveryBaselineStorage"]>): ReturnType<Runtime["readRecoveryBaselineStorage"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.readRecoveryBaselineStorage(...args));
}

export function readRecoveryBaselineResult(...args: Parameters<Runtime["readRecoveryBaselineResult"]>): ReturnType<Runtime["readRecoveryBaselineResult"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.readRecoveryBaselineResult(...args));
}

export function writeRecoveryStorage(...args: Parameters<Runtime["writeRecoveryStorage"]>): ReturnType<Runtime["writeRecoveryStorage"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.writeRecoveryStorage(...args));
}

export function removeRecoveryStorage(...args: Parameters<Runtime["removeRecoveryStorage"]>): ReturnType<Runtime["removeRecoveryStorage"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.removeRecoveryStorage(...args));
}

export function readLatestSessionCheckpointStatus(...args: Parameters<Runtime["readLatestSessionCheckpointStatus"]>): ReturnType<Runtime["readLatestSessionCheckpointStatus"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.readLatestSessionCheckpointStatus(...args));
}

export function readLatestSessionCheckpoint(...args: Parameters<Runtime["readLatestSessionCheckpoint"]>): ReturnType<Runtime["readLatestSessionCheckpoint"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.readLatestSessionCheckpoint(...args));
}

export function readLatestSessionCheckpointMetadata(...args: Parameters<Runtime["readLatestSessionCheckpointMetadata"]>): ReturnType<Runtime["readLatestSessionCheckpointMetadata"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.readLatestSessionCheckpointMetadata(...args));
}

export function readLatestSessionCheckpointMetadataResult(...args: Parameters<Runtime["readLatestSessionCheckpointMetadataResult"]>): ReturnType<Runtime["readLatestSessionCheckpointMetadataResult"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.readLatestSessionCheckpointMetadataResult(...args));
}

/** Retains the async public signature while making the callback available immediately. */
export async function setRecoveryDatabaseBlockedHandler(handler: Parameters<Runtime["setRecoveryDatabaseBlockedHandler"]>[0]): Promise<void> {
  setBlockedHandler(handler);
}

export function commitSessionCheckpoint(...args: Parameters<Runtime["commitSessionCheckpoint"]>): ReturnType<Runtime["commitSessionCheckpoint"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.commitSessionCheckpoint(...args));
}

export function flushSessionPersistence(...args: Parameters<Runtime["flushSessionPersistence"]>): ReturnType<Runtime["flushSessionPersistence"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.flushSessionPersistence(...args));
}

export function attachSessionWindow(...args: Parameters<Runtime["attachSessionWindow"]>): ReturnType<Runtime["attachSessionWindow"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.attachSessionWindow(...args));
}

export function heartbeatSessionWindow(lease: Parameters<Runtime["heartbeatSessionWindow"]>[0], dirtyRecoveryKeys?: Parameters<Runtime["heartbeatSessionWindow"]>[1], now = Date.now()): ReturnType<Runtime["heartbeatSessionWindow"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.heartbeatSessionWindow(lease, dirtyRecoveryKeys, now));
}

export function closeSessionWindow(...args: Parameters<Runtime["closeSessionWindow"]>): ReturnType<Runtime["closeSessionWindow"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.closeSessionWindow(...args));
}

export function readSessionRegistry(now = Date.now()): ReturnType<Runtime["readSessionRegistry"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.readSessionRegistry(now));
}

export function listRecoverableSessionCheckpoints(...args: Parameters<Runtime["listRecoverableSessionCheckpoints"]>): ReturnType<Runtime["listRecoverableSessionCheckpoints"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.listRecoverableSessionCheckpoints(...args));
}

export function listRecoverableSessionCheckpointCandidates(...args: Parameters<Runtime["listRecoverableSessionCheckpointCandidates"]>): ReturnType<Runtime["listRecoverableSessionCheckpointCandidates"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.listRecoverableSessionCheckpointCandidates(...args));
}

export function loadSessionCheckpoint(...args: Parameters<Runtime["loadSessionCheckpoint"]>): ReturnType<Runtime["loadSessionCheckpoint"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.loadSessionCheckpoint(...args));
}

export function loadSessionCheckpointResult(...args: Parameters<Runtime["loadSessionCheckpointResult"]>): ReturnType<Runtime["loadSessionCheckpointResult"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.loadSessionCheckpointResult(...args));
}

export function claimSessionWindow(...args: Parameters<Runtime["claimSessionWindow"]>): ReturnType<Runtime["claimSessionWindow"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.claimSessionWindow(...args));
}

export function claimRecoverableSessionCandidate(...args: Parameters<Runtime["claimRecoverableSessionCandidate"]>): ReturnType<Runtime["claimRecoverableSessionCandidate"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.claimRecoverableSessionCandidate(...args));
}

export function discardSessionCheckpoint(...args: Parameters<Runtime["discardSessionCheckpoint"]>): ReturnType<Runtime["discardSessionCheckpoint"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.discardSessionCheckpoint(...args));
}

export function getRecoveryStorageUsage(...args: Parameters<Runtime["getRecoveryStorageUsage"]>): ReturnType<Runtime["getRecoveryStorageUsage"]> {
  return loadSessionStorageRuntime().then((runtime) => runtime.getRecoveryStorageUsage(...args));
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
  ProjectSessionMetadata,
  RecoverableSession,
  RecoverableSessionCandidate,
  RecoveryBaseline,
  RecoverySnapshot,
  RecoveryStorageUsage,
  RecoveryStorageValue,
  StorageReadResult,
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
export type { SessionCheckpointLoadOptions } from "./session-storage-runtime";

export {
  baselineKeyForRecoveryKey,
  collectExpandedPaths,
  compactRecoverySnapshot,
  createSessionMetadata,
  createWindowSessionMetadata,
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

export { readStorage, removeStorage, writeStorage } from "./session-storage-basic";
