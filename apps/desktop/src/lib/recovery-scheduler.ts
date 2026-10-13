/**
 * Recovery write scheduling.
 *
 * Pure, testable debounce policy for per-tab recovery snapshots plus a small
 * scheduler that runs the writes during idle time and supports an immediate
 * flush (window close / save) that bypasses the debounce entirely.
 */

export type CheckpointDebounce = {
  /** Quiet delay before a recovery write is scheduled. */
  delay: number;
  /** Hard cap from the first pending edit; the write must run by then. */
  maxWait: number;
};

export const RECOVERY_DEBOUNCE_SMALL_BYTES = 1 * 1024 * 1024;
export const RECOVERY_DEBOUNCE_LARGE_BYTES = 5 * 1024 * 1024;

/** Debounce window by document size. */
export function checkpointDebounceForSize(byteLength: number): CheckpointDebounce {
  if (byteLength >= RECOVERY_DEBOUNCE_LARGE_BYTES) return { delay: 5000, maxWait: 15000 };
  if (byteLength >= RECOVERY_DEBOUNCE_SMALL_BYTES) return { delay: 2000, maxWait: 5000 };
  return { delay: 500, maxWait: 2000 };
}

/**
 * Delay for the next recovery write. Debounces by `delay` after the most
 * recent edit but never lets the first pending edit wait longer than
 * `maxWait`.
 */
export function nextRecoveryDelay(firstPendingAt: number, now: number, byteLength: number): number {
  const { delay, maxWait } = checkpointDebounceForSize(byteLength);
  return Math.max(0, Math.min(delay, firstPendingAt + maxWait - now));
}

type IdleCallbackHandle = number;

/**
 * Runs `task` inside requestIdleCallback when available, otherwise falls back
 * to a plain macrotask. Returns a cancel function.
 */
export function runRecoveryWhenIdle(task: () => void, timeoutMs: number): () => void {
  const target = globalThis as {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => IdleCallbackHandle;
    cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
  };
  if (typeof target.requestIdleCallback === "function") {
    const handle = target.requestIdleCallback(() => task(), { timeout: timeoutMs });
    return () => {
      if (typeof target.cancelIdleCallback === "function") target.cancelIdleCallback(handle);
    };
  }
  const handle = setTimeout(task, 0);
  return () => clearTimeout(handle);
}

type TimerHandle = ReturnType<typeof setTimeout>;

type PendingRecovery = {
  firstPendingAt: number;
  deadline: number;
  run: () => void;
  timer?: TimerHandle;
  deadlineTimer?: TimerHandle;
  cancelIdle?: () => void;
};

/**
 * Per-tab debounced write scheduler. Edits reschedule the pending write;
 * `flush` runs every pending write synchronously, bypassing both the debounce
 * timer and any queued idle callback (window close and save depend on this).
 */
export class RecoveryWriteScheduler {
  private pending = new Map<string, PendingRecovery>();

  schedule(tabId: string, sizeBytes: number, now: number, run: () => void): void {
    const policy = checkpointDebounceForSize(sizeBytes);
    const previous = this.pending.get(tabId);
    const firstPendingAt = previous?.firstPendingAt ?? now;
    const deadline = Math.min(previous?.deadline ?? Infinity, firstPendingAt + policy.maxWait);
    this.cancel(tabId);
    const pending: PendingRecovery = { firstPendingAt, deadline, run };
    this.pending.set(tabId, pending);
    const remaining = Math.max(0, deadline - now);
    const execute = () => {
      if (this.pending.get(tabId) !== pending) return;
      this.cancel(tabId);
      pending.run();
    };
    // This independent timer survives every idle handoff. New edits preserve
    // the same absolute deadline, even if an idle callback never runs.
    pending.deadlineTimer = setTimeout(execute, remaining);
    if (remaining === 0) return;
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      const idleRemaining = Math.max(0, deadline - Date.now());
      if (idleRemaining === 0) execute();
      else pending.cancelIdle = runRecoveryWhenIdle(execute, idleRemaining);
    }, Math.min(policy.delay, remaining));
  }

  pendingTabs(): string[] {
    return [...this.pending.keys()];
  }

  /** Stops tracking a tab without running its pending write. */
  cancel(tabId: string): void {
    const pending = this.pending.get(tabId);
    if (!pending) return;
    this.pending.delete(tabId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (pending.deadlineTimer !== undefined) clearTimeout(pending.deadlineTimer);
    pending.cancelIdle?.();
  }

  /** Runs every pending write immediately, ignoring the debounce. */
  flush(run: (tabId: string) => void): void {
    const pending = this.pendingTabs();
    for (const tabId of pending) this.cancel(tabId);
    for (const tabId of pending) run(tabId);
  }

  clear(): void {
    for (const tabId of this.pendingTabs()) this.cancel(tabId);
  }
}
