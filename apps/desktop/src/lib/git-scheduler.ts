import type { FileChange, FileChangeSource, GitDirtyScope, WatchRoot } from "../types";
import { isSameOrDescendantPath, pathComparisonKey, runtimePathOptions } from "./path-identity";

export type GitQueryScope = "status" | "branches" | "history";

export type GitDirtyState = {
  status: boolean;
  branches: boolean;
  history: boolean;
};

export const GIT_VISIBLE_DEBOUNCE_MS = 220;
export const GIT_HIDDEN_DEBOUNCE_MS = 1_200;
export const GIT_VISIBLE_MAX_WAIT_MS = 1_000;
export const GIT_HIDDEN_MAX_WAIT_MS = 5_000;

const PATH_OPTIONS = runtimePathOptions();

export function emptyGitDirtyState(): GitDirtyState {
  return { status: false, branches: false, history: false };
}

export function allGitDirtyState(): GitDirtyState {
  return { status: true, branches: true, history: true };
}

export function mergeGitDirtyState(current: GitDirtyState, next: GitDirtyState): GitDirtyState {
  return {
    status: current.status || next.status,
    branches: current.branches || next.branches,
    history: current.history || next.history,
  };
}

export function hasGitDirtyState(state: GitDirtyState): boolean {
  return state.status || state.branches || state.history;
}

export function queryScopesForGitDirtyState(state: GitDirtyState): GitQueryScope[] {
  const scopes: GitQueryScope[] = [];
  if (state.status) scopes.push("status");
  if (state.branches) scopes.push("branches");
  if (state.history) scopes.push("history");
  return scopes;
}

export function classifyGitChanges(changes: readonly FileChange[], repositoryRoot: string, watchRoots: readonly WatchRoot[] = []): GitDirtyState {
  if (!repositoryRoot) return emptyGitDirtyState();
  let state = emptyGitDirtyState();
  for (const change of changes) {
    state = mergeGitDirtyState(state, classifyGitChange(change, repositoryRoot, watchRoots));
    if (state.status && state.branches && state.history) return state;
  }
  return state;
}

export function classifyGitChange(change: FileChange, repositoryRoot: string, watchRoots: readonly WatchRoot[] = []): GitDirtyState {
  const source = change.source;
  const explicitScopes = change.gitScopes ?? [];
  if (explicitScopes.length) return stateForExplicitScopes(explicitScopes);
  if (source === "gitDir" || source === "commonDir") {
    const sourceRoot = watchRoots.find((root) => root.kind === source)?.path;
    return classifyGitMetadataPath(change.path, sourceRoot);
  }
  if (source === "external") return emptyGitDirtyState();
  if (!isSameOrDescendantPath(change.path, repositoryRoot, PATH_OPTIONS) && (!change.oldPath || !isSameOrDescendantPath(change.oldPath, repositoryRoot, PATH_OPTIONS))) {
    return emptyGitDirtyState();
  }
  return { status: true, branches: false, history: false };
}

export function gitRefreshDelay(visible: boolean, now: number, firstPendingAt: number | undefined): number {
  const debounce = visible ? GIT_VISIBLE_DEBOUNCE_MS : GIT_HIDDEN_DEBOUNCE_MS;
  const maxWait = visible ? GIT_VISIBLE_MAX_WAIT_MS : GIT_HIDDEN_MAX_WAIT_MS;
  const first = firstPendingAt ?? now;
  return Math.max(0, Math.min(debounce, first + maxWait - now));
}

function stateForExplicitScopes(scopes: readonly GitDirtyScope[]): GitDirtyState {
  let state = emptyGitDirtyState();
  for (const scope of scopes) {
    if (scope === "worktree" || scope === "index") state = mergeGitDirtyState(state, { status: true, branches: false, history: false });
    if (scope === "head") state = mergeGitDirtyState(state, { status: true, branches: true, history: true });
    if (scope === "refs") state = mergeGitDirtyState(state, { status: true, branches: true, history: true });
    if (scope === "unknown") state = allGitDirtyState();
  }
  return state;
}

function classifyGitMetadataPath(path: string, sourceRoot: string | undefined): GitDirtyState {
  if (!sourceRoot || !isSameOrDescendantPath(path, sourceRoot, PATH_OPTIONS)) return allGitDirtyState();
  const pathKey = pathComparisonKey(path, PATH_OPTIONS);
  const sourceKey = pathComparisonKey(sourceRoot, PATH_OPTIONS);
  const relative = pathKey.slice(sourceKey.length).replace(/^\/+/, "");
  if (relative === "index" || relative === "index.lock" || relative.startsWith("rebase-") || relative.startsWith("merge-") || relative.startsWith("sequencer/")) {
    return { status: true, branches: false, history: false };
  }
  if (relative === "head" || relative === "packed-refs" || relative === "config" || relative.startsWith("refs/") || relative.startsWith("logs/refs/") || relative.startsWith("worktrees/")) {
    return { status: true, branches: true, history: true };
  }
  return allGitDirtyState();
}
