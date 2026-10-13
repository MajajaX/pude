import { describe, expect, it, vi } from "vitest";
import { TerminalAckQueue, TerminalAckScheduler, TerminalAckTracker, TERMINAL_ACK_FLUSH_BYTES } from "./terminal-ack";

describe("terminal ack tracker", () => {
  it("acknowledges a contiguous run with the summed utf8 byte count", () => {
    const tracker = new TerminalAckTracker();
    const cjk = "繁體中文"; // 12 UTF-8 bytes, 4 UTF-16 code units
    tracker.recordWritten(1, 2);
    tracker.recordWritten(2, cjk.length);
    expect(tracker.drainBatch()).toEqual({ upToSeq: 2, bytes: 2 + cjk.length });
    expect(tracker.drainBatch()).toBeUndefined();
  });

  it("waits for a missing sequence instead of skipping it", () => {
    const tracker = new TerminalAckTracker();
    tracker.recordWritten(2, 5);
    expect(tracker.drainBatch()).toBeUndefined();
    tracker.recordWritten(1, 3);
    expect(tracker.drainBatch()).toEqual({ upToSeq: 2, bytes: 8 });
  });

  it("ignores stale completions from an earlier session", () => {
    const tracker = new TerminalAckTracker();
    tracker.recordWritten(1, 3);
    tracker.recordWritten(2, 4);
    tracker.recordWritten(1, 3);
    expect(tracker.drainBatch()).toEqual({ upToSeq: 2, bytes: 7 });
    tracker.recordWritten(1, 3);
    expect(tracker.drainBatch()).toBeUndefined();
  });

  it("rejects negative byte counts", () => {
    const tracker = new TerminalAckTracker();
    tracker.recordWritten(1, -1);
    expect(tracker.drainBatch()).toBeUndefined();
  });

  it("starts over from sequence one after a reset", () => {
    const tracker = new TerminalAckTracker();
    tracker.recordWritten(1, 3);
    tracker.recordWritten(3, 9);
    tracker.reset();
    tracker.recordWritten(1, 4);
    expect(tracker.drainBatch()).toEqual({ upToSeq: 1, bytes: 4 });
  });

  it("ignores a delayed parser completion from the previous generation", () => {
    const tracker = new TerminalAckTracker();
    expect(tracker.beginGeneration(17)).toBe(true);
    tracker.recordWritten(1, 3, 17);

    tracker.reset();
    expect(tracker.beginGeneration(18)).toBe(true);
    tracker.recordWritten(1, 3, 17);
    tracker.recordWritten(1, 5, 18);

    expect(tracker.drainBatch()).toEqual({ upToSeq: 1, bytes: 5 });
  });

  it("reports completed-but-undrained bytes for the flush threshold", () => {
    const tracker = new TerminalAckTracker();
    expect(tracker.pendingBytes()).toBe(0);
    tracker.recordWritten(2, 5);
    expect(tracker.pendingBytes()).toBe(5);
    tracker.recordWritten(1, 3);
    expect(tracker.pendingBytes()).toBe(8);
    expect(tracker.drainBatch()).toEqual({ upToSeq: 2, bytes: 8 });
    expect(tracker.pendingBytes()).toBe(0);
  });
});

describe("terminal ack scheduler", () => {
  function makeScheduler(flushBytes = TERMINAL_ACK_FLUSH_BYTES) {
    const frames = new Map<number, () => void>();
    let nextHandle = 1;
    const scheduler = new TerminalAckScheduler(
      (callback) => {
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      (handle) => { frames.delete(handle); },
      flushBytes,
    );
    const runFrame = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback());
    };
    return { scheduler, frames, runFrame };
  }

  it("defers small backlogs to the next animation frame", () => {
    const { scheduler, frames, runFrame } = makeScheduler();
    const flush = vi.fn();
    scheduler.schedule(flush);
    expect(flush).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    runFrame();
    expect(flush).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it("coalesces repeated schedules into a single frame", () => {
    const { scheduler, frames, runFrame } = makeScheduler();
    const flush = vi.fn();
    scheduler.schedule(flush);
    scheduler.schedule(flush);
    scheduler.schedule(flush);
    expect(frames.size).toBe(1);
    runFrame();
    expect(flush).toHaveBeenCalledOnce();
  });

  it("flushes immediately once the backlog reaches the byte threshold", () => {
    const { scheduler, frames, runFrame } = makeScheduler(32);
    const deferred = vi.fn();
    scheduler.schedule(deferred);
    expect(frames.size).toBe(1);

    const flush = vi.fn();
    scheduler.flushNow(flush);
    expect(flush).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    runFrame();
    expect(deferred).not.toHaveBeenCalled();
  });

  it("cancelScheduled drops a pending frame and reset is idempotent", () => {
    const { scheduler, frames } = makeScheduler();
    const flush = vi.fn();
    scheduler.schedule(flush);
    scheduler.cancelScheduled();
    expect(frames.size).toBe(0);
    scheduler.reset();
    scheduler.reset();
    expect(frames.size).toBe(0);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe("terminal ack queue", () => {
  it("reports an active acknowledgment failure and continues processing", async () => {
    const queue = new TerminalAckQueue();
    const onError = vi.fn();
    const failedAck = vi.fn(async () => { throw new Error("session not found"); });
    const nextAck = vi.fn(async () => undefined);

    queue.enqueue(failedAck, onError);
    await queue.enqueue(nextAck, onError);

    expect(failedAck).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "session not found" }));
    expect(nextAck).toHaveBeenCalledOnce();
  });

  it("keeps acknowledgments ordered while prior requests are pending", async () => {
    const queue = new TerminalAckQueue();
    const order: string[] = [];
    let finishFirst!: () => void;

    queue.enqueue(() => new Promise<void>((resolve) => {
      order.push("first-start");
      finishFirst = () => {
        order.push("first-end");
        resolve();
      };
    }), () => undefined);
    const completed = queue.enqueue(async () => { order.push("second"); }, () => undefined);
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    finishFirst();
    await completed;
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});
