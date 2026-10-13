import type { GitCommit, GitHistoryPage } from "../types";

export const GIT_HISTORY_PAGE_SIZE = 60;

export type GitHistoryViewState = {
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  incomplete?: string;
};

export type GitHistoryControllerOptions = {
  getWorkspace: () => string | null;
  getSnapshotKey: () => string | null;
  getCurrentCommits: () => readonly GitCommit[];
  setCommits: (commits: GitCommit[]) => void;
  onState: (state: GitHistoryViewState) => void;
  onLoaded: () => void;
  notify: (message: string) => void;
  loadPage: (workspace: string, cursor: string | null, pageSize: number) => Promise<GitHistoryPage>;
};

type HistoryContext = {
  generation: number;
  workspace: string;
  snapshotKey: string;
  key: string;
};

type HistoryRequest = {
  kind: "initial" | "older";
  context: HistoryContext;
  cursor: string | null;
  promise: Promise<boolean>;
};

const EMPTY_STATE: GitHistoryViewState = {
  loading: false,
  loadingOlder: false,
  hasMore: false,
  incomplete: undefined,
};

/** Owns Git history pagination and rejects pages from old workspace snapshots. */
export class GitHistoryController {
  private generation = 0;
  private cursor: string | null = null;
  private loadedKey: string | undefined;
  private request: HistoryRequest | undefined;
  private state: GitHistoryViewState = { ...EMPTY_STATE };
  private disposed = false;

  constructor(private readonly options: GitHistoryControllerOptions) {}

  getState(): GitHistoryViewState {
    return { ...this.state };
  }

  /** Load the first page, coalescing duplicate requests for this snapshot. */
  load(): Promise<boolean> {
    const context = this.prepareContext();
    if (!context) return Promise.resolve(false);
    if (this.request?.context.key === context.key) return this.request.promise;
    if (this.loadedKey === context.key) return Promise.resolve(false);
    return this.start(context, null, "initial");
  }

  /** Load the next 60-commit page and append only new commit OIDs. */
  loadOlder(): Promise<boolean> {
    const context = this.prepareContext();
    if (!context) return Promise.resolve(false);
    if (this.request?.context.key === context.key) return this.request.promise;
    if (this.loadedKey !== context.key || !this.state.hasMore || this.cursor === null) return Promise.resolve(false);
    return this.start(context, this.cursor, "older");
  }

  /** Invalidate pagination and pending replies while preserving displayed commits. */
  invalidate(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.request = undefined;
    this.cursor = null;
    this.loadedKey = undefined;
    this.updateState(EMPTY_STATE);
  }

  /** Invalidate pagination and clear the displayed history. */
  reset(): void {
    if (this.disposed) return;
    this.invalidate();
    this.options.setCommits([]);
  }

  /** Forget owned state and prevent later requests or callbacks from applying. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.request = undefined;
    this.cursor = null;
    this.loadedKey = undefined;
    this.state = { ...EMPTY_STATE };
  }

  private prepareContext(): HistoryContext | undefined {
    if (this.disposed) return undefined;
    let context = this.captureContext();
    if (!context) return undefined;
    if (this.request && this.request.context.key !== context.key) {
      this.invalidate();
      context = this.captureContext();
    }
    return context;
  }

  private captureContext(): HistoryContext | undefined {
    const workspace = this.options.getWorkspace();
    const snapshotKey = this.options.getSnapshotKey();
    if (workspace === null || snapshotKey === null) return undefined;
    return {
      generation: this.generation,
      workspace,
      snapshotKey,
      key: JSON.stringify([workspace, snapshotKey]),
    };
  }

  private start(context: HistoryContext, cursor: string | null, kind: HistoryRequest["kind"]): Promise<boolean> {
    if (kind === "initial") {
      this.cursor = null;
      this.updateState({ hasMore: false, incomplete: undefined });
    }

    const request: HistoryRequest = {
      kind,
      context,
      cursor,
      promise: Promise.resolve(false),
    };
    this.request = request;
    this.updateState(kind === "initial"
      ? { loading: true, loadingOlder: false }
      : { loadingOlder: true, loading: false });
    request.promise = this.run(request);
    return request.promise;
  }

  private async run(request: HistoryRequest): Promise<boolean> {
    try {
      const page = await this.options.loadPage(request.context.workspace, request.cursor, GIT_HISTORY_PAGE_SIZE);
      if (!this.isCurrent(request)) return false;

      if (request.kind === "initial") {
        this.options.setCommits(uniqueCommits(page.commits));
      } else {
        this.options.setCommits(appendUniqueCommits(this.options.getCurrentCommits(), page.commits));
      }

      this.cursor = page.cursor;
      const hasMore = page.hasMore && page.cursor !== null;
      this.loadedKey = request.context.key;
      this.updateState({
        hasMore,
        incomplete: page.complete ? undefined : incompletePageMessage(page, hasMore),
      });
      this.options.onLoaded();
      return true;
    } catch (error) {
      if (!this.isCurrent(request)) return false;
      this.handleError(request, error);
      return false;
    } finally {
      if (this.request === request) {
        this.request = undefined;
        this.updateState({ loading: false, loadingOlder: false });
      }
    }
  }

  private isCurrent(request: HistoryRequest): boolean {
    if (this.disposed || this.request !== request || request.context.generation !== this.generation) return false;
    return this.options.getWorkspace() === request.context.workspace
      && this.options.getSnapshotKey() === request.context.snapshotKey;
  }

  private handleError(request: HistoryRequest, error: unknown): void {
    const message = historyErrorText(error);
    if (isInvalidCursorError(error, message)) {
      this.cursor = null;
      this.loadedKey = undefined;
      const incomplete = "The Git history cursor expired or became invalid. Use Refresh history to start a new scan.";
      this.updateState({ hasMore: false, incomplete });
      this.options.notify(incomplete);
      return;
    }

    if (isCancelledError(error, message)) {
      this.cursor = null;
      this.loadedKey = undefined;
      const incomplete = "Git history loading was cancelled. Use Refresh history to try again.";
      this.updateState({ hasMore: false, incomplete });
      this.options.notify(incomplete);
      return;
    }

    const fallback = request.kind === "initial" ? "Unable to load Git history." : "Unable to load older Git history.";
    this.options.notify(message ? `${fallback} ${message}` : fallback);
  }

  private updateState(patch: Partial<GitHistoryViewState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.options.onState({ ...this.state });
  }
}

function uniqueCommits(commits: readonly GitCommit[]): GitCommit[] {
  const seen = new Set<string>();
  return commits.filter((commit) => {
    const oid = commit.hash.toLowerCase();
    if (seen.has(oid)) return false;
    seen.add(oid);
    return true;
  });
}

function appendUniqueCommits(existing: readonly GitCommit[], incoming: readonly GitCommit[]): GitCommit[] {
  const output = [...existing];
  const seen = new Set(existing.map((commit) => commit.hash.toLowerCase()));
  for (const commit of incoming) {
    const oid = commit.hash.toLowerCase();
    if (seen.has(oid)) continue;
    seen.add(oid);
    output.push(commit);
  }
  return output;
}

function incompletePageMessage(page: GitHistoryPage, hasMore: boolean): string {
  const reason = page.incompleteReason ?? "History request reached its work budget.";
  const unresolved = page.unresolvedRefs.length ? ` ${page.unresolvedRefs.length} refs remain unresolved.` : "";
  const action = hasMore ? "Use Load older or Refresh history to continue." : "Use Refresh history to start a new scan.";
  return `${reason}${unresolved} ${action}`;
}

function historyErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "error", "cause"]) {
      const value = record[key];
      if (typeof value === "string" && value) return value;
      if (value instanceof Error && value.message) return value.message;
      if (value && typeof value === "object" && typeof (value as Record<string, unknown>).message === "string") {
        return (value as Record<string, string>).message;
      }
    }
  }
  return "";
}

function isInvalidCursorError(error: unknown, message: string): boolean {
  const kind = error && typeof error === "object" ? (error as Record<string, unknown>).kind : undefined;
  const normalized = `${String(kind ?? "")} ${message}`.toLowerCase();
  const cursorProblem = normalized.includes("cursor")
    && /(expired|invalid|stale|no longer exists|reload history|changed|identity)/.test(normalized);
  const changedSnapshot = normalized.includes("reload history")
    && /(refs changed|refs or repository identity changed|repository identity changed|snapshot changed)/.test(normalized);
  return cursorProblem || changedSnapshot;
}

function isCancelledError(error: unknown, message: string): boolean {
  const kind = error && typeof error === "object" ? (error as Record<string, unknown>).kind : undefined;
  const normalized = `${String(kind ?? "")} ${message}`.toLowerCase();
  return normalized.includes("cancelled") || normalized.includes("canceled");
}
