/**
 * Public recovery/session boundary used by the application lifecycle.
 *
 * The implementation lives beside the legacy storage helpers so old sessions
 * can still be read while callers migrate to the checkpoint protocol.
 */
export {
  attachSessionWindow,
  claimSessionWindow,
  closeSessionWindow,
  commitSessionCheckpoint,
  discardSessionCheckpoint,
  flushSessionPersistence,
  getRecoveryStorageUsage,
  heartbeatSessionWindow,
  listRecoverableSessionCheckpoints,
  parseSessionCheckpoint,
  parseSessionRegistry,
  readLatestSessionCheckpoint,
  readLatestSessionCheckpointStatus,
  readSessionRegistry,
  sessionCheckpointStorageKey,
} from "./session-storage";

export type {
  AttachSessionWindowInput,
  ClaimSessionWindowInput,
  ClaimSessionWindowResult,
  DiscardSessionCheckpointResult,
  RecoverableSession,
  RecoveryStorageUsage,
  SessionCheckpoint,
  SessionCheckpointDurability,
  SessionCheckpointInput,
  SessionCheckpointReadResult,
  SessionCheckpointResult,
  SessionRegistry,
  SessionRegistryResult,
  SessionRegistryUpdateResult,
  SessionWindowLease,
  SessionWindowRecord,
} from "./session-storage";
