import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkpointDebounceForSize,
  nextRecoveryDelay,
  RecoveryWriteScheduler,
  RECOVERY_DEBOUNCE_LARGE_BYTES,
  RECOVERY_DEBOUNCE_SMALL_BYTES,
} from "./recovery-scheduler";

const MiB = 1024 * 1024;

describe("checkpointDebounceForSize", () => {
  it("debounces small documents by 500 ms with a 2 s ceiling", () => {
    expect(checkpointDebounceForSize(0)).toEqual({ delay: 500, maxWait: 2000 });
    expect(checkpointDebounceForSize(RECOVERY_DEBOUNCE_SMALL_BYTES - 1)).toEqual({ delay: 500, maxWait: 2000 });
  });

  it("debounces 1-5 MiB documents by 2 s with a 5 s ceiling", () => {
    expect(checkpointDebounceForSize(RECOVERY_DEBOUNCE_SMALL_BYTES)).toEqual({ delay: 2000, maxWait: 5000 });
    expect(checkpointDebounceForSize(3 * MiB)).toEqual({ delay: 2000, maxWait: 5000 });
    expect(checkpointDebounceForSize(RECOVERY_DEBOUNCE_LARGE_BYTES - 1)).toEqual({ delay: 2000, maxWait: 5000 });
  });

  it("debounces large documents by 5 s with a 15 s ceiling", () => {
    expect(checkpointDebounceForSize(RECOVERY_DEBOUNCE_LARGE_BYTES)).toEqual({ delay: 5000, maxWait: 15000 });
    expect(checkpointDebounceForSize(20 * MiB)).toEqual({ delay: 5000, maxWait: 15000 });
  });
});

describe("nextRecoveryDelay", () => {
  it("waits the full quiet delay for a fresh pending edit", () => {
    expect(nextRecoveryDelay(1000, 1000, 100)).toBe(500);
    expect(nextRecoveryDelay(1000, 1000, 3 * MiB)).toBe(2000);
    expect(nextRecoveryDelay(1000, 1000, 20 * MiB)).toBe(5000);
  });

  it("never lets the first pending edit exceed maxWait", () => {
    expect(nextRecoveryDelay(1000, 2500, 100)).toBe(500);
    expect(nextRecoveryDelay(1000, 3000, 100)).toBe(0);
    expect(nextRecoveryDelay(1000, 14000, 20 * MiB)).toBe(2000);
    expect(nextRecoveryDelay(1000, 16000, 20 * MiB)).toBe(0);
  });
});

describe("RecoveryWriteScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([ [100, 2000], [3 * MiB, 5000], [20 * MiB, 15000] ])(
    "enforces the %i-byte deadline when idle callbacks never execute",
    async (size, deadline) => {
      const idle = new Map<number, () => void>();
      let next = 0;
      vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
        idle.set(++next, callback);
        return next;
      });
      vi.stubGlobal("cancelIdleCallback", (id: number) => idle.delete(id));
      const scheduler = new RecoveryWriteScheduler();
      const runs = vi.fn();
      const start = Date.now();
      scheduler.schedule("tab", size, Date.now(), runs);
      while (Date.now() - start < deadline - 1) {
        await vi.advanceTimersByTimeAsync(Math.min(100, deadline - 1 - (Date.now() - start)));
        scheduler.schedule("tab", size, Date.now(), runs);
      }
      expect(runs).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(runs).toHaveBeenCalledTimes(1);
      expect(scheduler.pendingTabs()).toEqual([]);
      expect(idle.size).toBe(0);
    },
  );

  it("retains the deadline after debounce hands off to a starved idle callback", async () => {
    vi.stubGlobal("requestIdleCallback", () => 1);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const scheduler = new RecoveryWriteScheduler();
    const runs = vi.fn();
    scheduler.schedule("tab", 20 * MiB, Date.now(), runs);
    await vi.advanceTimersByTimeAsync(5001);
    scheduler.schedule("tab", 20 * MiB, Date.now(), runs);
    await vi.advanceTimersByTimeAsync(5001);
    scheduler.schedule("tab", 20 * MiB, Date.now(), runs);
    await vi.advanceTimersByTimeAsync(4998);
    expect(runs).toHaveBeenCalledTimes(1);
  });

  it("runs a pending write only after the debounce delay", async () => {
    const scheduler = new RecoveryWriteScheduler();
    const runs: string[] = [];
    scheduler.schedule("tab-1", 100, Date.now(), () => runs.push("tab-1"));
    await vi.advanceTimersByTimeAsync(499);
    expect(runs).toEqual([]);
    // The debounce timer fires at 500 ms and hands off to the idle fallback
    // macrotask, which runs within the same window.
    await vi.advanceTimersByTimeAsync(2);
    expect(runs).toEqual(["tab-1"]);
    expect(scheduler.pendingTabs()).toEqual([]);
  });

  it("uses the size-based delay for large documents", async () => {
    const scheduler = new RecoveryWriteScheduler();
    const runs: string[] = [];
    scheduler.schedule("tab-1", 20 * MiB, Date.now(), () => runs.push("tab-1"));
    await vi.advanceTimersByTimeAsync(4999);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(runs).toEqual(["tab-1"]);
  });

  it("rescheduling restarts the quiet delay while the write is still pending", async () => {
    const scheduler = new RecoveryWriteScheduler();
    const runs: string[] = [];
    const start = Date.now();
    scheduler.schedule("tab-1", 100, start, () => runs.push("tab-1"));
    await vi.advanceTimersByTimeAsync(400);
    scheduler.schedule("tab-1", 100, start + 400, () => runs.push("tab-1"));
    // The second edit restarts the 500 ms quiet delay: total 900 ms, not 500.
    await vi.advanceTimersByTimeAsync(499);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(runs).toEqual(["tab-1"]);
    expect(scheduler.pendingTabs()).toEqual([]);
  });

  it("flush runs pending writes immediately, bypassing the debounce", () => {
    const scheduler = new RecoveryWriteScheduler();
    const runs: string[] = [];
    scheduler.schedule("tab-1", 20 * MiB, Date.now(), () => runs.push("tab-1"));
    scheduler.schedule("tab-2", 100, Date.now(), () => runs.push("tab-2"));
    scheduler.flush((tabId) => runs.push(`flush:${tabId}`));
    expect(runs).toEqual(["flush:tab-1", "flush:tab-2"]);
    expect(scheduler.pendingTabs()).toEqual([]);
  });

  it("flush also cancels writes already queued inside an idle callback", async () => {
    const scheduler = new RecoveryWriteScheduler();
    const runs: string[] = [];
    scheduler.schedule("tab-1", 100, Date.now(), () => runs.push("idle:tab-1"));
    // Let the debounce timer fire; the write is now deferred to the idle
    // macrotask. Flushing must run it exactly once.
    await vi.advanceTimersByTimeAsync(500);
    scheduler.flush((tabId) => runs.push(`flush:${tabId}`));
    expect(runs).toEqual(["flush:tab-1"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(runs).toEqual(["flush:tab-1"]);
  });

  it("cancel drops a pending write", async () => {
    const scheduler = new RecoveryWriteScheduler();
    const runs: string[] = [];
    scheduler.schedule("tab-1", 100, Date.now(), () => runs.push("tab-1"));
    scheduler.cancel("tab-1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toEqual([]);
    expect(scheduler.pendingTabs()).toEqual([]);
  });
});
