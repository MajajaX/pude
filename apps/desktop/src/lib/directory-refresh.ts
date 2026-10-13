import type { DirectoryListResult } from "../types";

export type DirectoryRefreshContext = {
  generation: number;
  workspace: string;
};

export type DirectoryRefreshCoordinatorOptions = {
  getGeneration: () => number;
  getWorkspace: () => string | null;
  isDisposed: () => boolean;
  pathKey: (path: string) => string;
  isPathInWorkspace: (path: string, workspace: string) => boolean;
  isWorkspaceRoot: (path: string, workspace: string) => boolean;
  isExpanded: (path: string, workspace: string) => boolean;
  markStale: (path: string) => void;
  list: (path: string, requestId: string) => Promise<DirectoryListResult>;
  apply: (path: string, listing: DirectoryListResult, context: DirectoryRefreshContext) => void;
  onError: (path: string, error: unknown) => void;
  cancelDirectoryListing: (requestId: string) => Promise<unknown> | unknown;
  debounceMs?: number;
};

type ScheduledRefresh = {
  context: DirectoryRefreshContext;
  timer: ReturnType<typeof setTimeout>;
};

type InFlightRefresh = {
  path: string;
  pendingPath?: string;
  context: DirectoryRefreshContext;
  pending: boolean;
  invalidated: boolean;
  activeRequestId?: string;
  promise: Promise<boolean>;
};

let nextFallbackCoordinatorId = 0;

function createCoordinatorPrefix(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `directory-list-${randomId}`;
  return `directory-list-${Date.now().toString(36)}-${++nextFallbackCoordinatorId}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Debounces watcher-driven directory listings and serializes refreshes by
 * canonical path. An event during a listing requests one follow-up listing;
 * completing a parent listing never schedules its children.
 */
export class DirectoryRefreshCoordinator {
  private readonly scheduled = new Map<string, ScheduledRefresh>();
  private readonly inFlight = new Map<string, InFlightRefresh>();
  private readonly requestIdPrefix = createCoordinatorPrefix();
  private nextRequestNumber = 0;
  private disposed = false;

  constructor(private readonly options: DirectoryRefreshCoordinatorOptions) {}

  /** Schedule one expanded directory after the quiet period, usually 140 ms. */
  schedule(path: string): void {
    this.enqueue(path, false);
  }

  /**
   * Watcher overflow has an explicit root entry point. It refreshes only the
   * supplied workspace root; callers may deliberately schedule other paths
   * separately if they own a full-tree refresh policy.
   */
  scheduleOverflowRoot(path: string): void {
    const context = this.captureContext();
    if (!context || !this.options.isWorkspaceRoot(path, context.workspace)) return;
    this.enqueue(path, false, true);
  }

  /** Run a directory listing immediately, coalescing with any active request. */
  refresh(path: string): Promise<boolean> {
    return this.enqueue(path, true);
  }

  /** Cancel one path, or every pending and active path when omitted. */
  invalidate(path?: string): void {
    if (path !== undefined) {
      this.invalidateKey(this.options.pathKey(path));
      return;
    }
    const keys = new Set([...this.scheduled.keys(), ...this.inFlight.keys()]);
    for (const key of keys) this.invalidateKey(key);
  }

  /** Cancel all work and reject any later attempt to schedule more work. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
  }

  private enqueue(path: string, immediate: boolean, overflowRoot = false): Promise<boolean> {
    const context = this.captureContext();
    if (!context || !this.options.isPathInWorkspace(path, context.workspace)) return Promise.resolve(false);

    const isRoot = this.options.isWorkspaceRoot(path, context.workspace);
    if ((overflowRoot && !isRoot) || (!isRoot && !this.options.isExpanded(path, context.workspace))) {
      this.options.markStale(path);
      this.invalidateKey(this.options.pathKey(path));
      return Promise.resolve(false);
    }

    const key = this.options.pathKey(path);
    const active = this.inFlight.get(key);
    if (active && !this.sameContext(active.context, context)) this.invalidateKey(key);

    const current = this.inFlight.get(key);
    if (current) {
      if (!immediate) {
        current.pending = true;
        current.pendingPath = path;
      }
      return current.promise;
    }

    const scheduled = this.scheduled.get(key);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.scheduled.delete(key);
    }

    if (immediate) return this.start(path, key, context);

    const timer = setTimeout(() => {
      if (this.scheduled.get(key) !== record) return;
      this.scheduled.delete(key);
      if (!this.isContextCurrent(context)) return;
      if (!this.isEligible(path, context)) {
        this.options.markStale(path);
        return;
      }
      void this.start(path, key, context);
    }, this.options.debounceMs ?? 140);
    const record: ScheduledRefresh = { context, timer };
    this.scheduled.set(key, record);
    return Promise.resolve(false);
  }

  private start(path: string, key: string, context: DirectoryRefreshContext): Promise<boolean> {
    const existing = this.inFlight.get(key);
    if (existing) return existing.promise;

    const flight: InFlightRefresh = {
      path,
      context,
      pending: false,
      invalidated: false,
      promise: Promise.resolve(false),
    };
    this.inFlight.set(key, flight);
    flight.promise = this.runFlight(key, flight);
    return flight.promise;
  }

  private async runFlight(key: string, flight: InFlightRefresh): Promise<boolean> {
    let applied = false;
    let path = flight.path;

    try {
      while (!flight.invalidated) {
        if (!this.isCurrentFlight(key, flight, path)) {
          this.options.markStale(path);
          break;
        }

        const requestId = `${this.requestIdPrefix}-${++this.nextRequestNumber}`;
        flight.activeRequestId = requestId;
        try {
          const listing = await this.options.list(path, requestId);
          if (listing.stopReason === "cancelled") {
            if (this.isCurrentFlight(key, flight, path)) this.options.markStale(path);
          } else if (this.isCurrentFlight(key, flight, path)) {
            this.options.apply(path, listing, flight.context);
            applied = true;
          } else if (!flight.invalidated && this.isContextCurrent(flight.context)) {
            this.options.markStale(path);
          }
        } catch (error) {
          if (this.isCurrentFlight(key, flight, path)) this.options.onError(path, error);
        } finally {
          if (flight.activeRequestId === requestId) flight.activeRequestId = undefined;
        }

        if (flight.invalidated || !flight.pending) break;
        flight.pending = false;
        path = flight.pendingPath ?? path;
        flight.pendingPath = undefined;
      }
      return applied;
    } finally {
      if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
    }
  }

  private isCurrentFlight(key: string, flight: InFlightRefresh, path: string): boolean {
    return this.inFlight.get(key) === flight
      && !flight.invalidated
      && this.isContextCurrent(flight.context)
      && this.isEligible(path, flight.context);
  }

  private isEligible(path: string, context: DirectoryRefreshContext): boolean {
    return this.options.isPathInWorkspace(path, context.workspace)
      && (this.options.isWorkspaceRoot(path, context.workspace) || this.options.isExpanded(path, context.workspace));
  }

  private captureContext(): DirectoryRefreshContext | undefined {
    if (this.disposed || this.options.isDisposed()) return undefined;
    const workspace = this.options.getWorkspace();
    if (workspace === null) return undefined;
    return { generation: this.options.getGeneration(), workspace };
  }

  private isContextCurrent(context: DirectoryRefreshContext): boolean {
    return !this.disposed
      && !this.options.isDisposed()
      && this.options.getGeneration() === context.generation
      && this.options.getWorkspace() === context.workspace;
  }

  private sameContext(left: DirectoryRefreshContext, right: DirectoryRefreshContext): boolean {
    return left.generation === right.generation && left.workspace === right.workspace;
  }

  private invalidateKey(key: string): void {
    const scheduled = this.scheduled.get(key);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.scheduled.delete(key);
    }

    const flight = this.inFlight.get(key);
    if (!flight) return;
    flight.invalidated = true;
    flight.pending = false;
    this.inFlight.delete(key);
    if (flight.activeRequestId) {
      try {
        const cancellation = this.options.cancelDirectoryListing(flight.activeRequestId);
        void Promise.resolve(cancellation).catch(() => undefined);
      } catch {
        // Cancellation is best effort; invalidation still prevents stale apply.
      }
    }
  }
}
