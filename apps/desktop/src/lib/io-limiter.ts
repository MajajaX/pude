export const BUSY_ERROR_PREFIX = "BUSY:";
export const DEFAULT_MAX_CONCURRENT_IO = 4;
export const DEFAULT_MAX_PENDING_IO = 64;
const BUSY_MAX_RETRIES = 3;
const BUSY_BASE_DELAY_MS = 50;
const DEFAULT_CURRENT_DOCUMENT_BURST = 3;

export type IoPriority = "current-document" | "normal";

export type IoRequestOptions = {
  signal?: AbortSignal;
  /** Checked immediately before the task starts. Stale queued tasks never reach the backend. */
  isCurrent?: () => boolean;
  priority?: IoPriority;
};

export type IoLimiterOptions = {
  maxConcurrent?: number;
  maxPending?: number;
  currentDocumentBurst?: number;
};

type Subscriber<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  options: IoRequestOptions;
  abortListener?: () => void;
  settled: boolean;
};

type Job<T> = {
  task: () => Promise<T>;
  priority: IoPriority;
  key?: string;
  controller: AbortController;
  subscribers: Set<Subscriber<T>>;
  state: "queued" | "running";
};

type AnyJob = Job<unknown>;
type Outcome<T> = { ok: true; value?: T } | { ok: false; error: unknown };

export class IoLimiterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class IoBusyError extends IoLimiterError {
  constructor() {
    super("IO_QUEUE_FULL", `${BUSY_ERROR_PREFIX} frontend IO queue is full`);
  }
}

export class IoCancelledError extends IoLimiterError {
  constructor() {
    super("IO_CANCELLED", "Frontend IO request was cancelled");
  }
}

export class IoStaleGenerationError extends IoLimiterError {
  constructor() {
    super("IO_STALE_GENERATION", "Frontend IO request belongs to an expired generation");
  }
}

export class IoDisposedError extends IoLimiterError {
  constructor() {
    super("IO_DISPOSED", "Frontend IO limiter has been disposed");
  }
}

/**
 * Bounds backend work and its waiting queue. `maxPending` counts queued callers,
 * including callers joined to the same coalesced read. A coalesced in-flight
 * read also caps joined callers at `maxPending`, keeping its waiter list finite.
 */
export class IoLimiter {
  private readonly maxConcurrent: number;
  private readonly maxPending: number;
  private readonly currentDocumentBurst: number;
  private runningCount = 0;
  private pendingCountValue = 0;
  private readonly queue: AnyJob[] = [];
  private readonly coalesced = new Map<string, AnyJob>();
  private readonly runningJobs = new Set<AnyJob>();
  private disposed = false;
  private currentDocumentRunCount = 0;

  constructor(options?: number | IoLimiterOptions) {
    const normalized = typeof options === "number" ? { maxConcurrent: options } : options;
    this.maxConcurrent = Math.max(1, Math.floor(normalized?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_IO));
    this.maxPending = Math.max(0, Math.floor(normalized?.maxPending ?? DEFAULT_MAX_PENDING_IO));
    this.currentDocumentBurst = Math.max(1, Math.floor(normalized?.currentDocumentBurst ?? DEFAULT_CURRENT_DOCUMENT_BURST));
  }

  get activeCount(): number {
    return this.runningCount;
  }

  /** Number of callers waiting for a backend slot. */
  get pendingCount(): number {
    return this.pendingCountValue;
  }

  run<T>(task: () => Promise<T>, options: IoRequestOptions = {}): Promise<T> {
    return this.enqueue(task, options);
  }

  /**
   * Coalesce only read work. A write must use `run`, which always creates its
   * own job. The key includes the caller-supplied path, generation, and read
   * semantics without trimming or normalizing path identity.
   */
  read<T>(
    path: string,
    generation: string | number,
    semantics: string,
    task: () => Promise<T>,
    options: IoRequestOptions = {},
  ): Promise<T> {
    return this.enqueue(task, options, JSON.stringify([path, generation, semantics]));
  }

  /** Reject queued callers and promptly settle active callers. Started backend
   * work can continue until its promise settles if the backend ignores abort. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const outcome = { ok: false, error: new IoDisposedError() } as const;
    for (const job of [...this.queue]) {
      this.removeQueuedJob(job);
      this.settleAll(job, outcome);
    }
    for (const job of this.runningJobs) {
      job.controller.abort();
      this.settleAll(job, outcome);
    }
    this.coalesced.clear();
  }

  private enqueue<T>(task: () => Promise<T>, options: IoRequestOptions, key?: string): Promise<T> {
    if (this.disposed) return Promise.reject(new IoDisposedError());
    if (options.signal?.aborted) return Promise.reject(new IoCancelledError());
    if (!this.isCurrent(options)) return Promise.reject(new IoStaleGenerationError());

    const subscriber = this.makeSubscriber<T>(options);
    const existing = key === undefined ? undefined : this.coalesced.get(key) as Job<T> | undefined;
    if (existing) {
      if (existing.subscribers.size >= Math.max(1, this.maxPending)) {
        subscriber.reject(new IoBusyError());
        return subscriber.promise;
      }
      if (existing.state === "queued" && this.pendingCountValue >= this.maxPending) {
        subscriber.reject(new IoBusyError());
        return subscriber.promise;
      }
      existing.subscribers.add(subscriber);
      if (existing.state === "queued") {
        this.pendingCountValue += 1;
        if (options.priority === "current-document") existing.priority = "current-document";
      }
      this.attachAbort(existing, subscriber);
      return subscriber.promise;
    }

    if (this.runningCount >= this.maxConcurrent && this.pendingCountValue >= this.maxPending) {
      subscriber.reject(new IoBusyError());
      return subscriber.promise;
    }

    const job: Job<T> = {
      task,
      priority: options.priority ?? "normal",
      key,
      controller: new AbortController(),
      subscribers: new Set([subscriber]),
      state: "queued",
    };
    if (key !== undefined) this.coalesced.set(key, job as AnyJob);
    this.queue.push(job as AnyJob);
    this.pendingCountValue += 1;
    this.attachAbort(job, subscriber);
    this.drain();
    return subscriber.promise;
  }

  private makeSubscriber<T>(options: IoRequestOptions): Subscriber<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject, options, settled: false };
  }

  private attachAbort<T>(job: Job<T>, subscriber: Subscriber<T>): void {
    const signal = subscriber.options.signal;
    if (!signal) return;
    subscriber.abortListener = () => {
      this.settleSubscriber(job, subscriber, { ok: false, error: new IoCancelledError() });
      if (job.subscribers.size === 0) {
        job.controller.abort();
        if (job.state === "queued") this.removeQueuedJob(job as AnyJob);
        else this.clearCoalesced(job as AnyJob);
      }
    };
    signal.addEventListener("abort", subscriber.abortListener, { once: true });
    if (signal.aborted) subscriber.abortListener();
  }

  private settleSubscriber<T>(job: Job<T>, subscriber: Subscriber<T>, outcome: Outcome<T>): void {
    if (subscriber.settled) return;
    subscriber.settled = true;
    if (subscriber.abortListener) subscriber.options.signal?.removeEventListener("abort", subscriber.abortListener);
    if (job.state === "queued") this.pendingCountValue -= 1;
    job.subscribers.delete(subscriber);
    if (outcome.ok) subscriber.resolve(outcome.value as T);
    else subscriber.reject(outcome.error);
  }

  private settleAll<T>(job: Job<T>, outcome: Outcome<T>): void {
    for (const subscriber of Array.from(job.subscribers)) this.settleSubscriber(job, subscriber, outcome);
  }

  private isCurrent(options: IoRequestOptions): boolean {
    try {
      return options.isCurrent?.() ?? true;
    } catch {
      return false;
    }
  }

  private drain(): void {
    while (!this.disposed && this.runningCount < this.maxConcurrent && this.queue.length > 0) {
      const job = this.takeNextJob();
      if (!job) return;
      this.pendingCountValue -= job.subscribers.size;
      job.state = "running";
      this.start(job);
    }
  }

  private takeNextJob(): AnyJob | undefined {
    const hasCurrentDocument = this.queue.some((job) => job.priority === "current-document");
    const hasNormal = this.queue.some((job) => job.priority === "normal");
    const chooseNormal = hasNormal && (!hasCurrentDocument || this.currentDocumentRunCount >= this.currentDocumentBurst);
    const index = chooseNormal
      ? this.queue.findIndex((job) => job.priority === "normal")
      : this.queue.findIndex((job) => job.priority === "current-document");
    const [job] = this.queue.splice(index < 0 ? 0 : index, 1);
    if (job.priority === "current-document") this.currentDocumentRunCount += 1;
    else this.currentDocumentRunCount = 0;
    return job;
  }

  private start(job: AnyJob): void {
    this.runningCount += 1;
    this.runningJobs.add(job);
    void Promise.resolve()
      .then(() => this.runTask(job))
      .then(
        (value) => this.settleSuccess(job, value),
        (error) => this.settleAll(job, { ok: false, error }),
      )
      .finally(() => {
        this.runningCount -= 1;
        this.runningJobs.delete(job);
        this.clearCoalesced(job);
        this.drain();
      });
  }

  private runTask(job: AnyJob): Promise<unknown> | undefined {
    for (const subscriber of Array.from(job.subscribers)) {
      if (subscriber.options.signal?.aborted) {
        this.settleSubscriber(job, subscriber, { ok: false, error: new IoCancelledError() });
      } else if (!this.isCurrent(subscriber.options)) {
        this.settleSubscriber(job, subscriber, { ok: false, error: new IoStaleGenerationError() });
      }
    }
    if (job.subscribers.size === 0 || job.controller.signal.aborted) return undefined;
    return job.task();
  }

  private settleSuccess(job: AnyJob, value: unknown): void {
    for (const subscriber of Array.from(job.subscribers)) {
      if (subscriber.options.signal?.aborted) {
        this.settleSubscriber(job, subscriber, { ok: false, error: new IoCancelledError() });
      } else if (!this.isCurrent(subscriber.options)) {
        this.settleSubscriber(job, subscriber, { ok: false, error: new IoStaleGenerationError() });
      } else {
        this.settleSubscriber(job, subscriber, { ok: true, value });
      }
    }
  }

  private clearCoalesced(job: AnyJob): void {
    if (job.key !== undefined && this.coalesced.get(job.key) === job) this.coalesced.delete(job.key);
  }

  private removeQueuedJob(job: AnyJob): void {
    const index = this.queue.indexOf(job);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.clearCoalesced(job);
  }
}

export const sharedIoLimiter = new IoLimiter();

export function limitIo<T>(task: () => Promise<T>, options?: IoRequestOptions): Promise<T> {
  return sharedIoLimiter.run(task, options);
}

export function isBusyError(error: unknown): boolean {
  if (error instanceof IoBusyError) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.startsWith(BUSY_ERROR_PREFIX);
}

export async function withBusyRetry<T>(
  task: () => Promise<T>,
  options?: { maxRetries?: number; baseDelayMs?: number },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? BUSY_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? BUSY_BASE_DELAY_MS;
  let attempt = 0;
  for (;;) {
    try {
      return await task();
    } catch (error) {
      if (!isBusyError(error) || attempt >= maxRetries) throw error;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}
