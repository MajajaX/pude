export type RecoveryDatabaseOpenStatus = "blocked" | "timed-out";
export type RecoveryDatabaseBlockedHandler = (timeoutMs: number, status: RecoveryDatabaseOpenStatus) => void;

let recoveryDatabaseBlockedHandler: RecoveryDatabaseBlockedHandler | undefined;

export function setRecoveryDatabaseBlockedHandler(handler: RecoveryDatabaseBlockedHandler | undefined): void {
  recoveryDatabaseBlockedHandler = handler;
}

export function notifyRecoveryDatabaseBlocked(timeoutMs: number, status: RecoveryDatabaseOpenStatus): void {
  try {
    recoveryDatabaseBlockedHandler?.(timeoutMs, status);
  } catch {
    // UI callbacks must not break the bounded database open.
  }
}
