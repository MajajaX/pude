import { isImagePath } from "./file-metadata";
import {
  claimRecoverableSessionCandidate, closeSessionWindow,
  CURSOR_STORAGE_KEY,
  listRecoverableSessionCheckpointCandidates, loadSessionCheckpointResult,
  parseCursorPositions,
  readLatestSessionCheckpointMetadataResult,
  recoveryStorageKey, type RecoverableSessionCandidate, type SessionCheckpoint,
  type CursorPosition, type SessionMetadata, type SessionWindowLease,
  parseSession, readStorage, scopedStorageKey, SESSION_STORAGE_KEY,
  readSessionRegistry,
} from "./session-storage";

export type StartupSessionSelection = {
  scope: string;
  checkpoint: SessionCheckpoint | null;
  legacy: SessionMetadata | null;
  /** Lease adopted for restoring this checkpoint. */
  lease: SessionWindowLease | null;
  /** Lease whose release failed; it must not be used to restore or persist this selection. */
  pendingReleaseLease?: SessionWindowLease;
  /** Existing recovery could not be verified; this renderer must not replace it. */
  recoveryUnavailable?: boolean;
  /** Original selected-checkpoint load failure, retained if lease cleanup also fails. */
  startupError?: unknown;
  /** Cursor positions captured with the selected session scope. */
  cursorPositions?: Record<string, CursorPosition>;
  recoveredSecondary: boolean;
};

export type SessionStartupHooks = {
  readLegacy?: (scope: string) => SessionMetadata | null;
  confirmStaleRecovery: () => Promise<boolean>;
  notify: (message: string) => void;
  isCurrent: () => boolean;
};

/** Candidate discovery never loads document bodies; only the fenced choice does. */
export async function resolveStartupSession(windowId: string, hooks: SessionStartupHooks): Promise<StartupSessionSelection> {
  const empty = (): StartupSessionSelection => ({ scope: windowId, checkpoint: null, legacy: null, lease: null, recoveredSecondary: false });
  const notifySafely = (message: string) => {
    try { hooks.notify(message); } catch { /* A notification must not discard a claimed lease. */ }
  };
  const preferredResult = await readLatestSessionCheckpointMetadataResult(windowId);
  if (preferredResult.status === "unavailable") {
    return { ...empty(), recoveryUnavailable: true,
      ...(Object.prototype.hasOwnProperty.call(preferredResult, "error") ? { startupError: preferredResult.error } : {}) };
  }
  const preferred = preferredResult.status === "available" ? preferredResult.value.checkpoint : null;
  const readLegacy = () => hooks.readLegacy ? hooks.readLegacy(windowId) : readLegacySession(windowId);
  if (!hooks.isCurrent()) {
    const unverified = preferred
      ? preferred.session.tabs.some((tab) => tab.dirty)
      : readLegacy()?.tabs.some((tab) => !isImagePath(tab.path));
    return { ...empty(), ...(unverified ? { recoveryUnavailable: true } : {}) };
  }
  if (preferred) {
    let checkpoint: SessionCheckpoint | null;
    try {
      const result = await loadSessionCheckpointResult(windowId, { expected: preferred });
      if (result.status !== "available") {
        return { ...empty(), recoveryUnavailable: true,
          ...(result.status === "unavailable" && Object.prototype.hasOwnProperty.call(result, "error") ? { startupError: result.error } : {}) };
      }
      checkpoint = result.value;
    } catch (startupError) {
      return { ...empty(), recoveryUnavailable: true, startupError };
    }
    if (!hooks.isCurrent()) return { ...empty(), ...(preferred.session.tabs.some((tab) => tab.dirty) ? { recoveryUnavailable: true } : {}) };
    if (!checkpoint || checkpoint.scope !== windowId || checkpoint.checkpointId !== preferred.checkpointId
      || checkpoint.sequence !== preferred.sequence || checkpoint.session.workspace !== preferred.session.workspace) {
      return { ...empty(), recoveryUnavailable: true };
    }
    const cursorPositions = readStartupCursorPositions(windowId, checkpoint.session);
    return { ...empty(), checkpoint, legacy: null, ...(cursorPositions ? { cursorPositions } : {}) };
  }
  const legacy = readLegacy();
  if (legacy || windowId === "main" || !hooks.isCurrent()) {
    const cursorPositions = hooks.isCurrent() ? readStartupCursorPositions(windowId, legacy) : undefined;
    return { ...empty(), legacy, ...(cursorPositions ? { cursorPositions } : {}) };
  }

  const candidates = await listRecoverableSessionCheckpointCandidates();
  if (!hooks.isCurrent()) return empty();
  const adopt = async (candidate: RecoverableSessionCandidate, allowStale = false): Promise<StartupSessionSelection | null> => {
    const metadata = candidate.checkpoint;
    if (!metadata.scope || candidate.workspace !== metadata.session.workspace) {
      notifySafely("A recovered session checkpoint did not match its recorded scope or workspace and was ignored.");
      return null;
    }
    const claimed = await claimRecoverableSessionCandidate({
      windowId, workspace: candidate.workspace,
      candidate: { scope: metadata.scope, checkpointId: metadata.checkpointId, sequence: metadata.sequence },
      allowStale,
      dirtyRecoveryKeys: metadata.session.tabs.filter((tab) => tab.dirty).map((tab) => recoveryStorageKey(tab.id, metadata.scope)),
    });
    if (!claimed.ok || !claimed.lease) return null;
    const lease = claimed.lease;
    let checkpoint: SessionCheckpoint | null = null;
    let hasStartupError = false;
    let startupError: unknown;
    let recoveryUnavailable = false;
    try {
      if (claimed.reusedScope && lease.scope === metadata.scope && hooks.isCurrent()) {
        const result = await loadSessionCheckpointResult(lease.scope, { expected: metadata, lease });
        if (result.status === "available") checkpoint = result.value;
        else if (result.status === "unavailable") {
          recoveryUnavailable = true;
          hasStartupError = Object.prototype.hasOwnProperty.call(result, "error");
          startupError = result.error;
        }
      }
    } catch (error) {
      hasStartupError = true;
      startupError = error;
      recoveryUnavailable = true;
    }

    if (hooks.isCurrent() && checkpoint?.checkpointId === metadata.checkpointId
      && checkpoint.scope === metadata.scope && checkpoint.scope === lease.scope
        && checkpoint.sequence === metadata.sequence && checkpoint.session.workspace === candidate.workspace) {
      const cursorPositions = readStartupCursorPositions(lease.scope, checkpoint.session);
      return { scope: lease.scope, checkpoint, legacy: null, lease, recoveredSecondary: true,
        ...(cursorPositions ? { cursorPositions } : {}) };
    }

    let releaseFailed = false;
    try {
      const released = await closeSessionWindow(lease, { discardRecovery: false });
      if (!released.ok && released.reason !== "stale-lease") {
        releaseFailed = true;
      }
    } catch {
      releaseFailed = true;
    }

    if (releaseFailed) {
      notifySafely("Recovered session state could not be safely released; recovery is paused until the session lease is cleared.");
      return {
        ...empty(),
        pendingReleaseLease: lease,
        recoveryUnavailable: true,
        ...(hasStartupError ? { startupError } : {}),
      };
    }

    // Keep the selected body error observable after a successful release; if
    // cleanup also failed it was retained on the pending selection instead.
    if (hasStartupError) throw startupError;
    if (recoveryUnavailable || (metadata.scope === windowId && metadata.session.tabs.some((tab) => tab.dirty))) {
      return { ...empty(), recoveryUnavailable: true };
    }
    return null;
  };
  const closed = candidates.find((candidate) => candidate.completeMetadata && candidate.closedWindowIds.length > 0
    && candidate.activeWindowIds.length === 0 && candidate.staleWindowIds.length === 0);
  if (closed) {
    const restored = await adopt(closed);
    if (restored) { if (restored.recoveredSecondary) notifySafely("Recovered the last closed editor window."); return restored; }
  }
  const stale = candidates.find((candidate) => candidate.completeMetadata && candidate.activeWindowIds.length === 0
    && candidate.staleWindowIds.some((id) => id !== windowId));
  if (stale && hooks.isCurrent() && await hooks.confirmStaleRecovery() && hooks.isCurrent()) {
    const restored = await adopt(stale, true);
    if (restored) { if (restored.recoveredSecondary) notifySafely("Recovered changes from a previous editor window."); return restored; }
  }
  const cursorPositions = hooks.isCurrent() ? readStartupCursorPositions(windowId, legacy) : undefined;
  return { ...empty(), legacy, ...(cursorPositions ? { cursorPositions } : {}) };
}

function readStartupCursorPositions(scope: string, session: SessionMetadata | null): Record<string, CursorPosition> | undefined {
  if (!session || session.workspace === "pude-demo") return undefined;
  return parseCursorPositions(readStorage(scopedStorageKey(CURSOR_STORAGE_KEY, scope)));
}

function readLegacySession(scope: string): SessionMetadata | null {
  return parseSession(readStorage(scopedStorageKey(SESSION_STORAGE_KEY, scope)))
    ?? (scope === "main" ? parseSession(readStorage(SESSION_STORAGE_KEY)) : null);
}

/** Ownership is acquired after the primary body read; verify it again before allowing persistence. */
export async function validateStartupCheckpoint(checkpoint: SessionCheckpoint, lease: SessionWindowLease): Promise<boolean> {
  try {
    if (checkpoint.scope !== lease.scope) return false;
    const result = await readLatestSessionCheckpointMetadataResult(lease.scope);
    if (result.status !== "available") return false;
    const { checkpoint: current, completeMetadata } = result.value;
    if (!completeMetadata || current.scope !== checkpoint.scope
      || current.checkpointId !== checkpoint.checkpointId || current.sequence !== checkpoint.sequence
      || current.committedAt !== checkpoint.committedAt
      || JSON.stringify(current.session) !== JSON.stringify(checkpoint.session)) return false;
    const entries = (values: Record<string, number | null>) => JSON.stringify(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
    if (entries(current.recoveryRevisions) !== entries(checkpoint.recoveryRevisions)
      || JSON.stringify([...current.recoveryKeys].sort()) !== JSON.stringify(Object.keys(checkpoint.recoveries).sort())) return false;
    const registry = await readSessionRegistry();
    return registry.windows.some((entry) => entry.scope === lease.scope && entry.windowId === lease.windowId
      && entry.leaseId === lease.leaseId && entry.status === "open");
  } catch {
    return false;
  }
}
