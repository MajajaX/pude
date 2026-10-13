import { describe, expect, it } from "vitest";
import {
  IoBusyError,
  IoCancelledError,
  IoDisposedError,
  IoLimiter,
  IoStaleGenerationError,
  isBusyError,
  limitIo,
  withBusyRetry,
} from "./io-limiter";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await flushMicrotasks();
  }
  throw new Error("condition did not become true");
}

describe("IoLimiter", () => {
  it("holds running work to C=2 and keeps FIFO order within normal work", async () => {
    const limiter = new IoLimiter({ maxConcurrent: 2, maxPending: 8 });
    const gates = Array.from({ length: 5 }, () => deferred<number>());
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    const tasks = gates.map((gate, index) => limiter.run(async () => {
      started.push(index);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await gate.promise;
      } finally {
        active -= 1;
      }
    }));

    await waitFor(() => started.length === 2);
    expect(started).toEqual([0, 1]);
    expect(limiter.activeCount).toBe(2);
    expect(limiter.pendingCount).toBe(3);

    gates[0].resolve(0);
    await waitFor(() => started.length === 3);
    expect(started).toEqual([0, 1, 2]);
    gates[1].resolve(1);
    await waitFor(() => started.length === 4);
    gates[2].resolve(2);
    await waitFor(() => started.length === 5);
    gates[3].resolve(3);
    gates[4].resolve(4);

    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(maxActive).toBe(2);
    expect(limiter.activeCount).toBe(0);
    expect(limiter.pendingCount).toBe(0);
  });

  it("gives current-document work priority and grants normal work a fair slot", async () => {
    const limiter = new IoLimiter({ maxConcurrent: 1, maxPending: 8, currentDocumentBurst: 3 });
    const ids = ["occupied", "current-1", "current-2", "current-3", "current-4", "normal"];
    const gates = new Map(ids.map((id) => [id, deferred<string>()]));
    const started: string[] = [];
    const task = (id: string) => limiter.run(() => {
      started.push(id);
      return gates.get(id)!.promise;
    }, { priority: id.startsWith("current") ? "current-document" : "normal" });

    const tasks = [task("occupied")];
    await waitFor(() => started.length === 1);
    tasks.push(task("normal"));
    tasks.push(task("current-1"), task("current-2"), task("current-3"), task("current-4"));

    for (const id of ["occupied", "current-1", "current-2", "current-3", "normal", "current-4"]) {
      gates.get(id)!.resolve(id);
      await waitFor(() => started.includes(id === "current-4" ? "current-4" : nextExpected(id)));
    }

    await expect(Promise.all(tasks)).resolves.toEqual(["occupied", "normal", "current-1", "current-2", "current-3", "current-4"]);
    expect(started).toEqual(["occupied", "current-1", "current-2", "current-3", "normal", "current-4"]);
    expect(limiter.pendingCount).toBe(0);
  });

  it("rejects overflow, removes cancelled queued callers, and settles stale generations before backend execution", async () => {
    const limiter = new IoLimiter({ maxConcurrent: 1, maxPending: 1 });
    const activeGate = deferred<void>();
    const active = limiter.run(() => activeGate.promise);
    await waitFor(() => limiter.activeCount === 1);

    const controller = new AbortController();
    const queued = limiter.run(async () => "must not run", { signal: controller.signal });
    const queuedResult = expect(queued).rejects.toBeInstanceOf(IoCancelledError);
    await expect(limiter.run(async () => "overflow")).rejects.toMatchObject({
      code: "IO_QUEUE_FULL",
      message: expect.stringContaining("BUSY:"),
    });
    expect(isBusyError(new IoBusyError())).toBe(true);
    expect(limiter.pendingCount).toBe(1);
    controller.abort();
    await queuedResult;
    expect(limiter.pendingCount).toBe(0);

    let oldBackendCalls = 0;
    let generationIsCurrent = true;
    const stale = limiter.run(async () => { oldBackendCalls += 1; }, { isCurrent: () => generationIsCurrent });
    generationIsCurrent = false;
    activeGate.resolve();
    await active;
    await expect(stale).rejects.toBeInstanceOf(IoStaleGenerationError);
    expect(oldBackendCalls).toBe(0);
    expect(limiter.pendingCount).toBe(0);
    expect(limiter.activeCount).toBe(0);

    const lateGate = deferred<string>();
    let lateGenerationIsCurrent = true;
    let startedLateBackend = 0;
    const late = limiter.run(() => {
      startedLateBackend += 1;
      return lateGate.promise;
    }, { isCurrent: () => lateGenerationIsCurrent });
    await waitFor(() => startedLateBackend === 1);
    lateGenerationIsCurrent = false;
    lateGate.resolve("old workspace");
    await expect(late).rejects.toBeInstanceOf(IoStaleGenerationError);
    expect(limiter.activeCount).toBe(0);
  });

  it("coalesces reads only when path, generation, and semantics all match", async () => {
    const limiter = new IoLimiter({ maxConcurrent: 1, maxPending: 8 });
    const firstGate = deferred<string>();
    let sameKeyCalls = 0;
    let newGenerationCalls = 0;
    let newSemanticsCalls = 0;
    let newPathCalls = 0;
    const first = limiter.read("/a.txt", 7, "text", () => {
      sameKeyCalls += 1;
      return firstGate.promise;
    });
    await waitFor(() => sameKeyCalls === 1);
    const joined = limiter.read("/a.txt", 7, "text", async () => {
      sameKeyCalls += 1;
      return "wrong";
    });
    const anotherGeneration = limiter.read("/a.txt", 8, "text", async () => {
      newGenerationCalls += 1;
      return "new-generation";
    });
    const anotherSemantics = limiter.read("/a.txt", 7, "metadata", async () => {
      newSemanticsCalls += 1;
      return "metadata";
    });
    const anotherPath = limiter.read("/b.txt", 7, "text", async () => {
      newPathCalls += 1;
      return "other-path";
    });

    firstGate.resolve("same-result");
    await expect(Promise.all([first, joined, anotherGeneration, anotherSemantics, anotherPath])).resolves.toEqual([
      "same-result", "same-result", "new-generation", "metadata", "other-path",
    ]);
    expect(sameKeyCalls).toBe(1);
    expect(newGenerationCalls).toBe(1);
    expect(newSemanticsCalls).toBe(1);
    expect(newPathCalls).toBe(1);
    expect(limiter.pendingCount).toBe(0);
  });

  it("settles one cancelled coalesced caller without cancelling its peer or growing waiters without bound", async () => {
    const limiter = new IoLimiter({ maxConcurrent: 1, maxPending: 2 });
    const gate = deferred<string>();
    let backendCalls = 0;
    const task = () => {
      backendCalls += 1;
      return gate.promise;
    };
    const first = limiter.read("/shared.txt", 1, "text", task);
    await waitFor(() => backendCalls === 1);

    const controller = new AbortController();
    const cancelled = limiter.read("/shared.txt", 1, "text", task, { signal: controller.signal });
    const cancelledResult = expect(cancelled).rejects.toBeInstanceOf(IoCancelledError);
    await expect(limiter.read("/shared.txt", 1, "text", task)).rejects.toMatchObject({ code: "IO_QUEUE_FULL" });
    controller.abort();
    await cancelledResult;
    gate.resolve("shared value");

    await expect(first).resolves.toBe("shared value");
    expect(backendCalls).toBe(1);
    expect(limiter.pendingCount).toBe(0);
    expect(limiter.activeCount).toBe(0);
  });

  it("does not coalesce writes and settles active and queued callers on dispose", async () => {
    const limiter = new IoLimiter({ maxConcurrent: 1, maxPending: 4 });
    const activeGate = deferred<void>();
    let writes = 0;
    const active = limiter.run(async () => { writes += 1; await activeGate.promise; return "active"; });
    await waitFor(() => limiter.activeCount === 1);
    const firstWrite = limiter.run(async () => { writes += 1; return "write"; });
    const secondWrite = limiter.run(async () => { writes += 1; return "write"; });
    expect(limiter.pendingCount).toBe(2);

    const activeResult = expect(active).rejects.toBeInstanceOf(IoDisposedError);
    const firstWriteResult = expect(firstWrite).rejects.toBeInstanceOf(IoDisposedError);
    const secondWriteResult = expect(secondWrite).rejects.toBeInstanceOf(IoDisposedError);
    limiter.dispose();
    await Promise.all([activeResult, firstWriteResult, secondWriteResult]);
    expect(writes).toBe(1);
    expect(limiter.pendingCount).toBe(0);
    await expect(limiter.run(async () => undefined)).rejects.toBeInstanceOf(IoDisposedError);

    activeGate.resolve();
    await waitFor(() => limiter.activeCount === 0);
  });

  it("uses the shared limiter through the compatibility helper", async () => {
    await expect(limitIo(async () => 42)).resolves.toBe(42);
  });
});

function nextExpected(completed: string): string {
  const order = ["occupied", "current-1", "current-2", "current-3", "normal", "current-4"];
  return order[order.indexOf(completed) + 1] ?? completed;
}

describe("withBusyRetry", () => {
  it("recognizes BUSY: errors", () => {
    expect(isBusyError(new Error("BUSY: file queue is full"))).toBe(true);
    expect(isBusyError("BUSY: file queue is full")).toBe(true);
    expect(isBusyError(new Error("ENOENT"))).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
  });

  it("retries BUSY errors and gives up at the configured retry budget", async () => {
    let attempts = 0;
    const result = await withBusyRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("BUSY: file queue is full");
      return "done";
    }, { baseDelayMs: 1 });
    expect(result).toBe("done");
    expect(attempts).toBe(3);

    const busy = new Error("BUSY: file queue is full");
    await expect(withBusyRetry(async () => { throw busy; }, { maxRetries: 2, baseDelayMs: 1 })).rejects.toBe(busy);
  });

  it("does not retry other errors", async () => {
    let attempts = 0;
    const failure = new Error("ENOENT");
    await expect(withBusyRetry(async () => {
      attempts += 1;
      throw failure;
    })).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
});
