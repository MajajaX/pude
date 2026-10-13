import { describe, expect, it } from "vitest";
import {
  IoBusyError,
  IoCancelledError,
  IoDisposedError,
  IoLimiter,
  IoStaleGenerationError,
} from "./io-limiter";
import { VersionedFileReader, type VersionedFileReaderOptions } from "./versioned-file-reader";

function deferred<T>() {
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
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await flushMicrotasks();
  }
  throw new Error("condition did not become true");
}

function readerFor(
  readFile: (path: string) => Promise<string>,
  overrides: Partial<VersionedFileReaderOptions<string>> = {},
) {
  let generation = 1;
  let disposed = false;
  const workspaceAbort = new AbortController();
  let now = 0;
  const ioLimiter = new IoLimiter({ maxConcurrent: 2, maxPending: 8 });
  const reader = new VersionedFileReader<string>({
    ioLimiter,
    readFile,
    getGeneration: () => generation,
    getSignal: () => workspaceAbort.signal,
    isDisposed: () => disposed,
    pathKey: (path) => path.toLowerCase(),
    now: () => now,
    wait: async (milliseconds, signal) => {
      if (signal.aborted) throw new IoCancelledError();
      now += milliseconds;
    },
    ...overrides,
  });
  return {
    reader,
    ioLimiter,
    workspaceAbort,
    setGeneration: (value: number) => { generation = value; },
    setDisposed: (value: boolean) => { disposed = value; },
    advanceTime: (milliseconds: number) => { now += milliseconds; },
  };
}

describe("VersionedFileReader", () => {
  it("coalesces callers for the same path epoch", async () => {
    const gate = deferred<string>();
    let backendCalls = 0;
    const ioLimiter = new IoLimiter({ maxConcurrent: 1, maxPending: 8 });
    const reader = new VersionedFileReader({
      ioLimiter,
      readFile: async () => { backendCalls += 1; return gate.promise; },
      getGeneration: () => 7,
      getSignal: () => new AbortController().signal,
      isDisposed: () => false,
      pathKey: (path) => path.toLowerCase(),
    });

    const first = reader.read("/Project/README.md");
    await waitFor(() => backendCalls === 1);
    const joined = reader.read("/project/readme.md", "current-document");
    gate.resolve("same bytes");

    await expect(Promise.all([first, joined])).resolves.toEqual(["same bytes", "same bytes"]);
    expect(backendCalls).toBe(1);
    reader.dispose();
  });

  it("retries an in-flight old version and joins the newer read instead of returning stale bytes", async () => {
    const oldBytes = deferred<string>();
    const newBytes = deferred<string>();
    const gates = [oldBytes, newBytes];
    let backendCalls = 0;
    const ioLimiter = new IoLimiter({ maxConcurrent: 2, maxPending: 8 });
    const reader = new VersionedFileReader({
      ioLimiter,
      readFile: async () => gates[backendCalls++].promise,
      getGeneration: () => 4,
      getSignal: () => new AbortController().signal,
      isDisposed: () => false,
      pathKey: (path) => path,
      wait: async () => undefined,
    });

    const olderCaller = reader.read("/repo/file.ts");
    await waitFor(() => backendCalls === 1);
    reader.invalidate("/repo/file.ts");
    const newerCaller = reader.read("/repo/file.ts", "current-document");
    await waitFor(() => backendCalls === 2);

    oldBytes.resolve("old A bytes");
    await flushMicrotasks();
    expect(backendCalls).toBe(2);
    newBytes.resolve("new B bytes");

    await expect(Promise.all([olderCaller, newerCaller])).resolves.toEqual(["new B bytes", "new B bytes"]);
    expect(backendCalls).toBe(2);
    reader.dispose();
  });

  it("keeps epoch records bounded and gives a later read a fresh coalescing key", async () => {
    const ioLimiter = new IoLimiter({ maxConcurrent: 1, maxPending: 8 });
    const semanticsSeen: string[] = [];
    const originalRead = ioLimiter.read.bind(ioLimiter);
    ioLimiter.read = ((path, generation, semantics, task, options) => {
      semanticsSeen.push(semantics);
      return originalRead(path, generation, semantics, task, options);
    }) as typeof ioLimiter.read;
    const reader = new VersionedFileReader({
      ioLimiter,
      readFile: async () => "fresh bytes",
      getGeneration: () => 1,
      getSignal: () => new AbortController().signal,
      isDisposed: () => false,
      pathKey: (path) => path,
    });

    for (let index = 0; index < 2_000; index += 1) reader.invalidate(`/unobserved/${index}`);
    expect(reader.activePathCount).toBe(0);

    await expect(reader.read("/workspace/file.ts")).resolves.toBe("fresh bytes");
    expect(reader.activePathCount).toBe(0);
    await expect(reader.read("/workspace/file.ts")).resolves.toBe("fresh bytes");
    expect(reader.activePathCount).toBe(0);
    expect(semanticsSeen).toHaveLength(2);
    expect(semanticsSeen[0]).not.toBe(semanticsSeen[1]);
    reader.dispose();
  });

  it("does not join an abandoned backend flight after its callers cancel", async () => {
    const ioLimiter = new IoLimiter({ maxConcurrent: 1, maxPending: 4 });
    const oldBackendGate = deferred<string>();
    let backendCalls = 0;
    let currentSignal = new AbortController();
    const reader = new VersionedFileReader({
      ioLimiter,
      readFile: async () => {
        backendCalls += 1;
        return backendCalls === 1 ? oldBackendGate.promise : "latest bytes";
      },
      getGeneration: () => 3,
      getSignal: () => currentSignal.signal,
      isDisposed: () => false,
      pathKey: (path) => path,
    });

    const oldRead = reader.read("/workspace/abandoned.ts");
    const oldRejection = expect(oldRead).rejects.toBeInstanceOf(IoCancelledError);
    await waitFor(() => backendCalls === 1);
    currentSignal.abort();
    await oldRejection;
    expect(reader.activePathCount).toBe(0);

    currentSignal = new AbortController();
    const latestRead = reader.read("/workspace/abandoned.ts");
    expect(ioLimiter.pendingCount).toBe(1);
    oldBackendGate.resolve("stale native bytes");

    await expect(latestRead).resolves.toBe("latest bytes");
    expect(backendCalls).toBe(2);
    reader.dispose();
  });

  it("propagates queue overflow even if a watcher invalidates the path before rejection settles", async () => {
    const ioLimiter = new IoLimiter({ maxConcurrent: 1, maxPending: 1 });
    const runningGate = deferred<void>();
    const running = ioLimiter.run(async () => runningGate.promise);
    await waitFor(() => ioLimiter.activeCount === 1);
    const queued = ioLimiter.run(async () => undefined);
    const workspaceAbort = new AbortController();
    let backendCalls = 0;
    const reader = new VersionedFileReader({
      ioLimiter,
      readFile: async () => { backendCalls += 1; return "should not run"; },
      getGeneration: () => 1,
      getSignal: () => workspaceAbort.signal,
      isDisposed: () => false,
      pathKey: (path) => path,
    });

    const overflowingRead = reader.read("/workspace/full-queue.ts");
    const rejection = expect(overflowingRead).rejects.toBeInstanceOf(IoBusyError);
    reader.invalidate("/workspace/full-queue.ts");
    await rejection;
    expect(backendCalls).toBe(0);

    runningGate.resolve();
    await Promise.all([running, queued]);
    reader.dispose();
  });

  it("skips queued stale work and resolves the original open/restore caller with current bytes", async () => {
    const ioLimiter = new IoLimiter({ maxConcurrent: 1, maxPending: 8 });
    const blocker = deferred<string>();
    let backendCalls = 0;
    const occupied = ioLimiter.run(() => blocker.promise);
    await waitFor(() => ioLimiter.activeCount === 1);
    const reader = new VersionedFileReader({
      ioLimiter,
      readFile: async () => { backendCalls += 1; return "current disk bytes"; },
      getGeneration: () => 12,
      getSignal: () => new AbortController().signal,
      isDisposed: () => false,
      pathKey: (path) => path,
    });

    const restoreRead = reader.read("/workspace/restored.ts");
    expect(ioLimiter.pendingCount).toBe(1);
    reader.invalidate("/workspace/restored.ts");
    blocker.resolve("blocker done");
    await occupied;

    await expect(restoreRead).resolves.toBe("current disk bytes");
    expect(backendCalls).toBe(1);
    expect(ioLimiter.pendingCount).toBe(0);
    reader.dispose();
  });

  it("stops retrying when workspace cancellation changes the signal or generation", async () => {
    const gate = deferred<string>();
    let backendCalls = 0;
    const fixture = readerFor(async () => { backendCalls += 1; return gate.promise; });
    const read = fixture.reader.read("/workspace/file.ts");
    const rejected = expect(read).rejects.toBeInstanceOf(IoCancelledError);
    await waitFor(() => backendCalls === 1);

    fixture.reader.invalidate("/workspace/file.ts");
    fixture.reader.reset();
    fixture.setGeneration(2);
    fixture.workspaceAbort.abort();
    await rejected;
    gate.resolve("late old workspace bytes");
    await flushMicrotasks();

    expect(backendCalls).toBe(1);
    fixture.reader.dispose();
  });

  it("passes backend retries a signal and freshness predicate for the captured caller", async () => {
    const gate = deferred<string>();
    const workspaceAbort = new AbortController();
    let generation = 9;
    let backendCalls = 0;
    let backendContext: { signal: AbortSignal; isCurrent: () => boolean } | undefined;
    const reader = new VersionedFileReader({
      ioLimiter: new IoLimiter({ maxConcurrent: 1, maxPending: 4 }),
      readFile: async (_path, context) => {
        backendCalls += 1;
        backendContext = context;
        return gate.promise;
      },
      getGeneration: () => generation,
      getSignal: () => workspaceAbort.signal,
      isDisposed: () => false,
      pathKey: (path) => path,
    });
    const read = reader.read("/workspace/retry.ts");
    const rejection = expect(read).rejects.toBeInstanceOf(IoCancelledError);
    await waitFor(() => backendCalls === 1);
    expect(backendContext?.signal.aborted).toBe(false);
    expect(backendContext?.isCurrent()).toBe(true);

    reader.invalidate("/workspace/retry.ts");
    expect(backendContext?.isCurrent()).toBe(false);
    generation += 1;
    workspaceAbort.abort();
    expect(backendContext?.signal.aborted).toBe(true);
    expect(backendContext?.isCurrent()).toBe(false);
    await rejection;
    gate.resolve("late bytes");
    reader.dispose();
  });

  it("returns a clear file_changed error after continuous path churn reaches the freshness deadline", async () => {
    let now = 0;
    let backendCalls = 0;
    let reader!: VersionedFileReader<string>;
    const ioLimiter = new IoLimiter({ maxConcurrent: 1, maxPending: 4 });
    reader = new VersionedFileReader({
      ioLimiter,
      readFile: async () => {
        backendCalls += 1;
        reader.invalidate("/workspace/churning.ts");
        return `version ${backendCalls}`;
      },
      getGeneration: () => 1,
      getSignal: () => new AbortController().signal,
      isDisposed: () => false,
      pathKey: (path) => path,
      freshnessDeadlineMs: 25,
      retryDelayMs: 10,
      now: () => now,
      wait: async (milliseconds, signal) => {
        if (signal.aborted) throw new IoCancelledError();
        now += milliseconds;
      },
    });

    await expect(reader.read("/workspace/churning.ts")).rejects.toMatchObject({
      name: "FileChangedDuringReadError",
      code: "file_changed",
      message: expect.stringContaining("kept changing while it was being read"),
    });
    expect(backendCalls).toBe(4);
    reader.dispose();
  });

  it("settles active callers on dispose and does not schedule another read", async () => {
    const gate = deferred<string>();
    let backendCalls = 0;
    const fixture = readerFor(async () => { backendCalls += 1; return gate.promise; });
    const read = fixture.reader.read("/workspace/file.ts");
    const rejected = expect(read).rejects.toBeInstanceOf(IoDisposedError);
    await waitFor(() => backendCalls === 1);

    fixture.reader.invalidate("/workspace/file.ts");
    fixture.reader.dispose();
    await rejected;
    gate.resolve("late bytes");
    await flushMicrotasks();

    expect(backendCalls).toBe(1);
  });

  it("rejects stale workspace attempts after reset even when the generation callback has not changed yet", async () => {
    const gate = deferred<string>();
    let backendCalls = 0;
    const fixture = readerFor(async () => { backendCalls += 1; return gate.promise; });
    const read = fixture.reader.read("/workspace/file.ts");
    const rejected = expect(read).rejects.toBeInstanceOf(IoStaleGenerationError);
    await waitFor(() => backendCalls === 1);

    fixture.reader.reset();
    gate.resolve("old scope bytes");
    await rejected;
    await flushMicrotasks();
    expect(backendCalls).toBe(1);
    fixture.reader.dispose();
  });
});
