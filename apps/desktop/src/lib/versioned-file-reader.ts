import {
  IoCancelledError,
  IoDisposedError,
  IoLimiter,
  IoStaleGenerationError,
  isBusyError,
  type IoPriority,
} from "./io-limiter";

const DEFAULT_FRESHNESS_DEADLINE_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 10;
const READ_SEMANTICS = "normalized-utf8";

export class FileChangedDuringReadError extends Error {
  readonly code = "file_changed";

  constructor(path: string) {
    super(`The file kept changing while it was being read: ${path}. Retry the read.`);
    this.name = "FileChangedDuringReadError";
  }
}

export type VersionedFileReadContext = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

export type VersionedFileReaderOptions<T> = {
  ioLimiter: Pick<IoLimiter, "read">;
  readFile: (path: string, context?: VersionedFileReadContext) => Promise<T>;
  getGeneration: () => string | number;
  getSignal: () => AbortSignal;
  isDisposed: () => boolean;
  pathKey: (path: string) => string;
  /** How long repeatedly stale reads may retry. Defaults to five seconds. */
  freshnessDeadlineMs?: number;
  /** Delay between stale attempts. Defaults to 10 ms. */
  retryDelayMs?: number;
  /** Clock and wait hooks keep deadline behavior deterministic in tests. */
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

type ActivePathVersion = {
  epoch: number;
  readers: number;
};

/**
 * Reads the newest observed bytes for a path while sharing same-version reads
 * through IoLimiter. A watcher invalidation makes queued old reads skippable;
 * callers whose in-flight read became stale retry the new path epoch.
 */
export class VersionedFileReader<T> {
  private readonly activePathVersions = new Map<string, ActivePathVersion>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly freshnessDeadlineMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private scopeEpoch = 0;
  private nextPathEpoch = 1;
  private disposed = false;

  constructor(private readonly options: VersionedFileReaderOptions<T>) {
    this.freshnessDeadlineMs = Math.max(0, options.freshnessDeadlineMs ?? DEFAULT_FRESHNESS_DEADLINE_MS);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? waitForRetry;
  }

  /** Mark a changed path before deciding whether an open tab needs refreshing. */
  invalidate(path: string): void {
    if (this.disposed || this.isExternallyDisposed()) return;
    const key = this.options.pathKey(path);
    const activeVersion = this.activePathVersions.get(key);
    if (activeVersion) activeVersion.epoch = this.allocatePathEpoch();
  }

  /** Drop path versions at a workspace boundary and invalidate all old attempts. */
  reset(): void {
    this.scopeEpoch += 1;
    this.activePathVersions.clear();
  }

  /** Cancel this reader's callers without disposing the shared IO limiter. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scopeEpoch += 1;
    this.activePathVersions.clear();
    for (const controller of this.activeControllers) controller.abort();
  }

  read(path: string, priority: IoPriority = "normal"): Promise<T> {
    return this.readLatest(path, priority);
  }

  private async readLatest(path: string, priority: IoPriority): Promise<T> {
    const generation = this.options.getGeneration();
    const parentSignal = this.options.getSignal();
    const pathKey = this.options.pathKey(path);
    const scopeEpoch = this.scopeEpoch;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    let pathVersion: ActivePathVersion | undefined;

    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", forwardAbort, { once: true });
    this.activeControllers.add(controller);

    let staleSince: number | undefined;
    try {
      this.assertCallerCurrent(generation, parentSignal, scopeEpoch);
      pathVersion = this.acquirePathVersion(pathKey);

      while (true) {
        this.assertCallerCurrent(generation, parentSignal, scopeEpoch);
        const pathEpoch = pathVersion.epoch;
        const isAttemptCurrent = () => this.isCallerCurrent(generation, parentSignal, scopeEpoch)
          && pathVersion?.epoch === pathEpoch;
        const semantics = `${READ_SEMANTICS}:${scopeEpoch}:${pathEpoch}`;

        try {
          const value = await this.options.ioLimiter.read(
            pathKey,
            generation,
            semantics,
            () => {
              this.assertCallerCurrent(generation, parentSignal, scopeEpoch);
              if (pathVersion?.epoch !== pathEpoch) throw new IoStaleGenerationError();
              return this.options.readFile(path, { signal: controller.signal, isCurrent: isAttemptCurrent });
            },
            {
              signal: controller.signal,
              priority,
              isCurrent: isAttemptCurrent,
            },
          );

          this.assertCallerCurrent(generation, parentSignal, scopeEpoch);
          if (pathVersion.epoch === pathEpoch) return value;
        } catch (error) {
          this.assertCallerCurrent(generation, parentSignal, scopeEpoch);
          if (pathVersion.epoch === pathEpoch || isBusyError(error)) throw error;
        }

        const now = this.now();
        if (staleSince === undefined) staleSince = now;
        if (now - staleSince >= this.freshnessDeadlineMs) throw new FileChangedDuringReadError(path);
        await this.wait(this.retryDelayMs, controller.signal);
      }
    } finally {
      parentSignal.removeEventListener("abort", forwardAbort);
      this.activeControllers.delete(controller);
      if (pathVersion) this.releasePathVersion(pathKey, pathVersion);
    }
  }

  /** Number of path-version records held only while callers are active. */
  get activePathCount(): number {
    return this.activePathVersions.size;
  }

  private acquirePathVersion(pathKey: string): ActivePathVersion {
    const activeVersion = this.activePathVersions.get(pathKey);
    if (activeVersion) {
      activeVersion.readers += 1;
      return activeVersion;
    }

    const version = { epoch: this.allocatePathEpoch(), readers: 1 };
    this.activePathVersions.set(pathKey, version);
    return version;
  }

  private releasePathVersion(pathKey: string, version: ActivePathVersion): void {
    version.readers -= 1;
    if (version.readers === 0 && this.activePathVersions.get(pathKey) === version) {
      this.activePathVersions.delete(pathKey);
    }
  }

  private allocatePathEpoch(): number {
    const epoch = this.nextPathEpoch;
    this.nextPathEpoch += 1;
    return epoch;
  }

  private isCallerCurrent(generation: string | number, signal: AbortSignal, scopeEpoch: number): boolean {
    return !this.disposed
      && !this.isExternallyDisposed()
      && !signal.aborted
      && scopeEpoch === this.scopeEpoch
      && generation === this.options.getGeneration();
  }

  private assertCallerCurrent(generation: string | number, signal: AbortSignal, scopeEpoch: number): void {
    if (this.disposed || this.isExternallyDisposed()) throw new IoDisposedError();
    if (signal.aborted) throw new IoCancelledError();
    if (scopeEpoch !== this.scopeEpoch || generation !== this.options.getGeneration()) throw new IoStaleGenerationError();
  }

  private isExternallyDisposed(): boolean {
    try {
      return this.options.isDisposed();
    } catch {
      return true;
    }
  }
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new IoCancelledError());
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      clearTimeout(timer);
      resolve();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new IoCancelledError());
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
