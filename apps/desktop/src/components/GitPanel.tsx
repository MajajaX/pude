import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";
import { GitHistory } from "./GitHistory";
import { GitStashView } from "./GitStashView";
import { errorMessage, gitStatusLabel } from "../lib/core";
import { splitDisplayPath } from "../lib/display-path";
import { isTauri } from "../lib/bridge";
import { defaultGitWorktreePath } from "../lib/git-worktree";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import {
  GIT_STATUS_HEADER_HEIGHT,
  buildGitStatusRows,
  gitStatusRowHeight,
  gitStatusWindow,
  layoutGitStatusRows,
  resolveGitStatusFocus,
  type GitStatusRow,
} from "../lib/git-status-virtualization";
import type { GitActionRequest, GitBranch, GitCommit, GitCommitFile, GitFileStatus, GitStash, GitStashFile, GitStatusResult } from "../types";
import { t, translatable } from "../lib/i18n";

type GitDialog =
  | { kind: "commit" }
  | { kind: "switch" }
  | { kind: "create-branch"; commit?: GitCommit }
  | { kind: "create-worktree" }
  | { kind: "delete-branch" }
  | { kind: "confirm"; request: GitActionRequest; message: string }
  | { kind: "error"; title: string; message: string };

const actionLabel = (action: GitActionRequest["action"]) => t(actionLabels[action]);
const actionLabels: Record<GitActionRequest["action"], string> = {
  add: translatable("Stage all"),
  "stage-file": translatable("Stage file"),
  "unstage-file": translatable("Unstage file"),
  "unstage-all": translatable("Unstage all"),
  "discard-file": translatable("Discard change"),
  "discard-untracked-file": translatable("Discard untracked file"),
  commit: translatable("Commit"),
  "commit-all": translatable("Stage all and commit"),
  push: translatable("Push"),
  pull: translatable("Pull"),
  stash: translatable("Stash"),
  "stash-pop": translatable("Stash pop"),
  "stash-apply": translatable("Apply stash"),
  "stash-drop": translatable("Drop stash"),
  switch: translatable("Switch branch"),
  "create-branch": translatable("Create branch"),
  "delete-branch": translatable("Delete branch"),
};

export type GitPanelProps = {
  status: GitStatusResult;
  branches: GitBranch[];
  historyLoading: boolean;
  historyIncomplete?: string;
  historyHasMore: boolean;
  historyLoadingMore: boolean;
  /** Increments whenever loaded history is out of date, for example after a commit, push or ref change. */
  historyRevision: number;
  onLoadMoreHistory: () => void;
  onLoadHistory: () => void;
  onRefreshHistory?: () => void;
  onOpenHistory?: () => void;
  historyOnly?: boolean;
  onOpenDiff: (file: GitFileStatus, staged: boolean, untrackedHint?: boolean) => void;
  onOpenCommitDiff: (commit: GitCommit, file: GitCommitFile) => void;
  onLoadCommitFiles: (commit: GitCommit) => Promise<GitCommitFile[]>;
  onAction: (request: GitActionRequest) => Promise<void>;
  onCreateWorktree: (branchName: string, path: string, startPoint?: string) => Promise<void>;
  stashes?: GitStash[];
  onLoadStashFiles?: (stash: GitStash) => Promise<GitStashFile[]>;
  onOpenStashDiff?: (stash: GitStash, file: GitStashFile) => void;
};

export function GitPanel(props: GitPanelProps) {
  const [view, setView] = createSignal<"status" | "graph" | "stash">(props.historyOnly ? "graph" : "status");
  const stashCount = () => props.stashes?.length ?? 0;
  createEffect(() => {
    if (view() === "stash" && !stashCount()) setView("status");
  });
  const [actionFeedback, setActionFeedback] = createSignal("");
  const [dialog, setDialog] = createSignal<GitDialog>();
  const [commitMessage, setCommitMessage] = createSignal("");
  const [quickCommitMessage, setQuickCommitMessage] = createSignal("");
  const [branchName, setBranchName] = createSignal("");
  const [worktreePath, setWorktreePath] = createSignal("");
  const [selectedBranch, setSelectedBranch] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [commitFiles, setCommitFiles] = createSignal<Record<string, GitCommitFile[]>>({});
  const [loadingCommit, setLoadingCommit] = createSignal<string>();
  const [commitLoadErrors, setCommitLoadErrors] = createSignal<Record<string, string>>({});
  const [queuedCommits, setQueuedCommits] = createSignal<string[]>([]);
  const commitLoadQueue: GitCommit[] = [];
  let drainingCommitFiles = false;
  let commitQueueGeneration = 0;
  let previousRepositoryRoot = "";
  let previousHistoryLoadKey = "";
  let loadedHistoryRevision = -1;
  let worktreePathEdited = false;

  createEffect(() => {
    const repositoryRoot = props.status.repositoryRoot;
    if (previousRepositoryRoot && repositoryRoot !== previousRepositoryRoot) {
      commitQueueGeneration += 1;
      commitLoadQueue.length = 0;
      setQueuedCommits([]);
      setCommitFiles({});
      setCommitLoadErrors({});
      setLoadingCommit(undefined);
    }
    previousRepositoryRoot = repositoryRoot;

    const historyLoadKey = `${repositoryRoot}:${props.status.repositoryState ?? "unknown"}:${props.status.branch ?? ""}:${props.status.headOid ?? ""}`;
    const historyRevision = props.historyRevision;
    if (view() === "graph" && historyLoadKey && (historyLoadKey !== previousHistoryLoadKey || historyRevision !== loadedHistoryRevision)) {
      previousHistoryLoadKey = historyLoadKey;
      loadedHistoryRevision = historyRevision;
      props.onLoadHistory();
    }
  });

  onCleanup(() => {
    commitQueueGeneration += 1;
    commitLoadQueue.length = 0;
  });

  const repositoryState = () => props.status.repositoryState ?? (props.status.branch ? "normal" : "unknown");
  const hasRepository = () => repositoryState() !== "unknown";
  const confirmAction = (request: GitActionRequest, message: string) => setDialog({ kind: "confirm", request, message });
  const confirmQuickCommit = () => {
    const message = quickCommitMessage().trim();
    if (!message || busy() || !hasRepository()) return;
    confirmAction(
      { action: "commit-all", message },
      t("New, modified, and deleted files will all be staged before the commit."),
    );
  };
  const run = async (request: GitActionRequest) => {
    if (busy()) return;
    setBusy(true);
    setActionFeedback("");
    try {
      await props.onAction(request);
      setActionFeedback(t("{action} completed", { action: actionLabel(request.action) }));
      setDialog(undefined);
      setCommitMessage("");
      if (request.action === "commit-all") setQuickCommitMessage("");
      setBranchName("");
      setSelectedBranch("");
    } catch (error) {
      setDialog({ kind: "error", title: t("{action} failed", { action: actionLabel(request.action) }), message: errorMessage(error, "Git operation failed.") });
    } finally {
      setBusy(false);
    }
  };

  const openCommitDialog = () => {
    setCommitMessage("");
    setDialog({ kind: "commit" });
  };

  const openSwitchDialog = () => {
    setSelectedBranch(props.branches.find((branch) => !branch.current)?.name ?? props.status.branch ?? "");
    setDialog({ kind: "switch" });
  };

  const openCreateBranchDialog = (commit?: GitCommit) => {
    setBranchName("");
    setDialog({ kind: "create-branch", commit });
  };

  const openCreateWorktreeDialog = () => {
    const branch = "feature/new-worktree";
    worktreePathEdited = false;
    setBranchName(branch);
    setWorktreePath(defaultGitWorktreePath(props.status.repositoryRoot, branch));
    setDialog({ kind: "create-worktree" });
  };

  const updateWorktreeBranchName = (branch: string) => {
    setBranchName(branch);
    if (!worktreePathEdited) setWorktreePath(defaultGitWorktreePath(props.status.repositoryRoot, branch));
  };

  const createWorktree = async () => {
    if (busy()) return;
    setBusy(true);
    try {
      await props.onCreateWorktree(branchName().trim(), worktreePath().trim(), props.status.headOid ?? undefined);
      setActionFeedback(t("Worktree created and opened in a new window"));
      setDialog(undefined);
      setBranchName("");
      setWorktreePath("");
    } catch (error) {
      setDialog({ kind: "error", title: "Create worktree failed", message: errorMessage(error, "Unable to create the Git worktree.") });
    } finally {
      setBusy(false);
    }
  };

  const openDeleteBranchDialog = () => {
    setSelectedBranch(props.branches.find((branch) => !branch.current)?.name ?? "");
    setDialog({ kind: "delete-branch" });
  };

  const currentHistoryKey = () => `${props.status.repositoryRoot}:${props.status.repositoryState ?? "unknown"}:${props.status.branch ?? ""}:${props.status.headOid ?? ""}`;
  const isQueued = (hash: string) => commitLoadQueue.some((commit) => commit.hash === hash);
  const drainCommitFiles = async () => {
    if (drainingCommitFiles) return;
    drainingCommitFiles = true;
    while (commitLoadQueue.length) {
      const commit = commitLoadQueue.shift();
      if (commit) setQueuedCommits((items) => items.filter((hash) => hash !== commit.hash));
      if (!commit || Object.prototype.hasOwnProperty.call(commitFiles(), commit.hash)) continue;
      const requestKey = currentHistoryKey();
      const requestGeneration = commitQueueGeneration;
      setLoadingCommit(commit.hash);
      setCommitLoadErrors((current) => { const next = { ...current }; delete next[commit.hash]; return next; });
      try {
        const files = await props.onLoadCommitFiles(commit);
        if (commitQueueGeneration === requestGeneration && currentHistoryKey() === requestKey) setCommitFiles((current) => ({ ...current, [commit.hash]: files }));
      } catch (error) {
        const message = errorMessage(error, "Unable to load commit files.");
        if (commitQueueGeneration === requestGeneration && currentHistoryKey() === requestKey) setCommitLoadErrors((current) => ({ ...current, [commit.hash]: message }));
      } finally {
        if (commitQueueGeneration === requestGeneration) setLoadingCommit((current) => current === commit.hash ? undefined : current);
      }
    }
    drainingCommitFiles = false;
  };
  const loadCommitFiles = (commit: GitCommit) => {
    if (Object.prototype.hasOwnProperty.call(commitFiles(), commit.hash) || loadingCommit() === commit.hash || isQueued(commit.hash)) return;
    commitLoadQueue.push(commit);
    setQueuedCommits((items) => [...items, commit.hash]);
    void drainCommitFiles();
  };

  return (
    <section classList={{ "git-panel": true, "git-panel-history-only": Boolean(props.historyOnly), "git-panel-history-mode": Boolean(props.historyOnly) || view() === "graph" }}>
      <Show when={!props.historyOnly}><div class="git-panel-heading sidebar-toolbar">{t("Branch")}<span class="git-panel-branch"><Icon name="git" size={13} /><span>{repositoryState() === "detached" ? t("HEAD detached") : repositoryState() === "unborn" ? t("{value} (unborn)", { value: props.status.branch ?? "unborn" }) : props.status.branch ?? t("No repository")}</span></span></div></Show>
      <div classList={{ "git-content": true, "git-content-history-mode": Boolean(props.historyOnly) || view() === "graph" }}>
        <Show when={!props.historyOnly}>
        <form class="git-quick-commit" onSubmit={(event) => {
          event.preventDefault();
          confirmQuickCommit();
        }}>
          <label for="git-quick-commit-message">{t("Commit message")}</label>
          <div class="git-quick-commit-controls">
            <input id="git-quick-commit-message" value={quickCommitMessage()} placeholder={t("Commit message")} onInput={(event) => setQuickCommitMessage(event.currentTarget.value)} disabled={busy() || !hasRepository()} />
            <button type="submit" disabled={busy() || !hasRepository() || !quickCommitMessage().trim()} title={t("Stage all changes and commit")}>{t("Commit")}</button>
          </div>
        </form>
        <div class="git-action-menu git-action-options" role="group" aria-label={t("Git operations")}>
          <div class="git-action-group-label">{t("Changes")}</div>
          <div class="git-action-grid">
            <GitActionButton label={t("Stage all")} title={t("Stage all changes")} disabled={busy() || !hasRepository()} onClick={() => void run({ action: "add" })} />
            <GitActionButton label={t("Commit")} title={t("Commit staged changes")} disabled={busy() || !hasRepository()} onClick={openCommitDialog} />
          </div>
          <div class="git-action-group-label">{t("Sync")}</div>
          <div class="git-action-grid">
            <GitActionButton label={t("Push")} title={t("Push current branch")} disabled={busy() || !hasRepository()} onClick={() => confirmAction({ action: "push" }, t("Push local commits to the remote branch? Other collaborators may see these changes."))} />
            <GitActionButton label={t("Pull")} title={t("Pull current branch")} disabled={busy() || !hasRepository()} onClick={() => confirmAction({ action: "pull" }, t("Pull may change local files and create merge conflicts. Continue?"))} />
          </div>
          <div class="git-action-group-label">{t("Branches")}</div>
          <div class="git-action-grid">
            <GitActionButton label={t("Switch")} title={t("Switch branch")} disabled={busy() || !hasRepository() || !props.branches.length} onClick={openSwitchDialog} />
            <GitActionButton label={t("Create")} title={t("Create branch from HEAD")} disabled={busy() || !hasRepository()} onClick={() => openCreateBranchDialog()} />
            <GitActionButton label={t("Delete")} title={t("Delete a branch")} disabled={busy() || !hasRepository() || props.branches.length < 2} onClick={openDeleteBranchDialog} />
            <GitActionButton label={t("New worktree")} title={t("Create a branch in a separate worktree")} disabled={busy() || !hasRepository() || !isTauri} onClick={openCreateWorktreeDialog} />
          </div>
          <div class="git-action-group-label">{t("Stash")}</div>
          <div class="git-action-grid">
            <GitActionButton label={t("Save stash")} title={t("Stash all changes")} disabled={busy() || !hasRepository()} onClick={() => confirmAction({ action: "stash" }, t("Save current changes to a stash and remove them from the working tree?"))} />
            <GitActionButton label={t("Pop stash")} title={t("Pop the latest stash")} disabled={busy() || !hasRepository()} onClick={() => confirmAction({ action: "stash-pop" }, t("Apply and remove the latest stash? This may create conflicts."))} />
          </div>
        </div>
        <Show when={actionFeedback()}><div class="git-action-feedback" role="status"><Icon name="check" size={12} />{actionFeedback()}</div></Show>
        <div class="git-view-tabs" role="tablist" aria-label={t("Git views")}>
          <button classList={{ "git-view-tab": true, "git-view-tab-active": view() === "status" }} role="tab" aria-selected={view() === "status"} onClick={() => setView("status")}>{t("STATUS")}</button>
          <button classList={{ "git-view-tab": true, "git-view-tab-active": view() === "graph" }} role="tab" aria-selected={view() === "graph"} onClick={() => setView("graph")}>{t("HISTORY")} <span>{props.status.commits.length}</span></button>
          <Show when={stashCount()}>
            <button classList={{ "git-view-tab": true, "git-view-tab-active": view() === "stash" }} role="tab" aria-selected={view() === "stash"} onClick={() => setView("stash")}>{t("STASH")} <span>{stashCount()}</span></button>
          </Show>
        </div>
        <Show when={props.status.error}>
          <div class="empty-git git-error-message">{props.status.error}</div>
        </Show>
        <Show when={view() === "status" && repositoryState() !== "unknown" && !props.status.error}>
          <StatusView status={props.status} busy={busy()} onOpenDiff={props.onOpenDiff} onAction={(request) => void run(request)} onDiscard={(file) => confirmAction({ action: file.worktreeStatus === "?" ? "discard-untracked-file" : "discard-file", value: file.path }, file.worktreeStatus === "?" ? t("Delete the untracked file {path}? This cannot be undone.", { path: file.path }) : t("Discard working tree changes in {path}? This cannot be undone.", { path: file.path }))} />
        </Show>
        <Show when={view() === "status" && repositoryState() === "unknown" && !props.status.error}>
          <div class="empty-git">{t("No repository or Git status available")}</div>
        </Show>
        <Show when={view() === "stash" && props.onLoadStashFiles && props.onOpenStashDiff}>
          <GitStashView
            stashes={props.stashes ?? []}
            busy={busy()}
            onLoadFiles={(stash) => props.onLoadStashFiles!(stash)}
            onOpenDiff={(stash, file) => props.onOpenStashDiff!(stash, file)}
            onApply={(stash) => confirmAction({ action: "stash-apply", value: stash.reference, startPoint: stash.hash }, t("Apply {reference} to the working tree and keep it in the stash list? This may create conflicts.", { reference: stash.reference }))}
            onPop={(stash) => confirmAction({ action: "stash-pop", value: stash.reference, startPoint: stash.hash }, t("Apply {reference} and remove it from the stash list? This may create conflicts.", { reference: stash.reference }))}
            onDrop={(stash) => confirmAction({ action: "stash-drop", value: stash.reference, startPoint: stash.hash }, t("Delete {reference} without applying it? Its changes cannot be restored from pude.", { reference: stash.reference }))}
          />
        </Show>
        </Show>
        <Show when={props.historyOnly || view() === "graph"}>
          <GitHistory
            repositoryRoot={props.status.repositoryRoot}
            branches={props.branches}
            commits={props.status.commits}
            headOid={props.status.headOid}
            currentBranch={props.status.branch}
            repositoryState={repositoryState()}
            loading={props.historyLoading}
            error={props.historyIncomplete ?? props.status.error}
            fullMode={props.historyOnly}
            commitFiles={commitFiles()}
            commitLoadErrors={commitLoadErrors()}
            isLoading={(hash) => loadingCommit() === hash || queuedCommits().includes(hash)}
            onLoadFiles={(commit) => void loadCommitFiles(commit)}
            onOpenDiff={props.onOpenCommitDiff}
            onCreateBranch={openCreateBranchDialog}
            onRefresh={() => props.onRefreshHistory ? props.onRefreshHistory() : props.onLoadHistory()}
            onOpenHistory={props.historyOnly ? undefined : props.onOpenHistory}
            historyHasMore={props.historyHasMore}
            historyLoadingMore={props.historyLoadingMore}
            onLoadMoreHistory={props.onLoadMoreHistory}
          />
        </Show>
      </div>
      <Show when={dialog()}>{(current) => <GitDialogView
        dialog={current()}
        branches={props.branches}
        currentBranch={props.status.branch}
        commitMessage={commitMessage()}
        branchName={branchName()}
        worktreePath={worktreePath()}
        selectedBranch={selectedBranch()}
        busy={busy()}
        onCommitMessage={setCommitMessage}
        onBranchName={setBranchName}
        onWorktreePath={(path) => { worktreePathEdited = true; setWorktreePath(path); }}
        onWorktreeBranchName={updateWorktreeBranchName}
        onSelectedBranch={setSelectedBranch}
        onClose={() => { if (!busy()) setDialog(undefined); }}
        onCommit={() => void run({ action: "commit", message: commitMessage() })}
        onSwitch={() => void run({ action: "switch", value: selectedBranch() })}
        onCreateBranch={() => {
          const state = current();
          if (state.kind !== "create-branch") return;
          void run({ action: "create-branch", value: branchName(), startPoint: state.commit?.hash });
        }}
        onDelete={() => void run({ action: "delete-branch", value: selectedBranch() })}
        onConfirm={() => { const state = current(); if (state.kind === "confirm") void run(state.request); }}
        onCreateWorktree={() => void createWorktree()}
      />}</Show>
    </section>
  );
}

function GitActionButton(props: { label: string; title: string; disabled?: boolean; onClick: () => void }) {
  return <button class="git-action-button" type="button" title={props.title} disabled={props.disabled} onClick={props.onClick}>{props.label}<Icon name="chevron-right" size={11} /></button>;
}

const GIT_STATUS_OVERSCAN = 8;

function StatusView(props: { status: GitStatusResult; busy: boolean; onOpenDiff: (file: GitFileStatus, staged: boolean, untrackedHint?: boolean) => void; onAction: (request: GitActionRequest) => void; onDiscard: (file: GitFileStatus) => void }) {
  const rows = createMemo(() => buildGitStatusRows(props.status.files));
  const layout = createMemo(() => layoutGitStatusRows(rows()));
  const untracked = () => props.status.files.some((file) => file.worktreeStatus === "?");
  const [hostElement, setHostElement] = createSignal<HTMLDivElement>();
  let scrollHost: HTMLElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [focusAnchor, setFocusAnchor] = createSignal<{ key: string; index: number }>();

  // The git panel scrolls as a whole; the row window is computed in list
  // coordinates by subtracting the list offset within the scroll host.
  const listTop = () => {
    const host = hostElement();
    if (!scrollHost || !host) return 0;
    return host.getBoundingClientRect().top - scrollHost.getBoundingClientRect().top + scrollHost.scrollTop;
  };
  const window = createMemo(() => gitStatusWindow(rows(), layout(), Math.max(0, scrollTop() - listTop()), viewportHeight(), GIT_STATUS_OVERSCAN));
  const rowIndexes = createMemo(() => new Map(rows().map((row, index) => [row.key, index])));
  const renderedRows = createMemo(() => {
    const currentWindow = window();
    const currentRows = rows();
    // Retain status row identity between scroll updates so focused buttons
    // survive while their rows remain in the virtual window.
    const visible: GitStatusRow[] = [];
    for (let index = currentWindow.start; index < currentWindow.end; index += 1) {
      const row = currentRows[index];
      if (row) visible.push(row);
    }
    return visible;
  });

  const updateViewport = () => {
    if (!scrollHost) return;
    setViewportHeight(scrollHost.clientHeight);
    setScrollTop(scrollHost.scrollTop);
  };

  createEffect(() => {
    const list = hostElement();
    const host = list?.isConnected ? list.closest<HTMLElement>(".git-panel") ?? undefined : undefined;
    if (!host) {
      scrollHost = undefined;
      setScrollTop(0);
      setViewportHeight(0);
      return;
    }
    scrollHost = host;
    const handleScroll = () => updateViewport();
    host.addEventListener("scroll", handleScroll, { passive: true });
    updateViewport();
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateViewport);
    resizeObserver?.observe(scrollHost);
    // The quick-commit form, action menu, and feedback message sit above the
    // list and change its offset when they appear or collapse.
    const mutationObserver = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(updateViewport);
    mutationObserver?.observe(scrollHost, { childList: true, subtree: true });
    onCleanup(() => {
      host.removeEventListener("scroll", handleScroll);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (scrollHost === host) scrollHost = undefined;
    });
  });

  const ensureRowVisible = (index: number) => {
    const currentRows = rows();
    const row = currentRows[index];
    if (!row || !scrollHost) return;
    const rowTop = layout().offsets[index];
    const rowBottom = rowTop + gitStatusRowHeight(row);
    const hostTop = listTop();
    const viewport = viewportHeight();
    const relativeTop = scrollHost.scrollTop - hostTop;
    let target = scrollHost.scrollTop;
    if (rowTop < relativeTop) target = hostTop + rowTop;
    else if (rowBottom > relativeTop + viewport) target = hostTop + rowBottom - viewport;
    const maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
    target = Math.min(Math.max(0, target), maxTop);
    if (target === scrollHost.scrollTop) return;
    scrollHost.scrollTop = target;
    setScrollTop(target);
  };

  const focusRowElement = (key: string) => {
    const element = hostElement()?.querySelector(`[data-row-key="${CSS.escape(key)}"]`)?.querySelector("button");
    if (element instanceof HTMLButtonElement) element.focus();
  };

  const focusRowByIndex = (index: number) => {
    const row = rows()[index];
    if (!row) return;
    setFocusAnchor({ key: row.key, index });
    ensureRowVisible(index);
    queueMicrotask(() => focusRowElement(row.key));
  };

  // When the list updates and the focused row disappears (staged, discarded,
  // or refreshed away), move focus to a nearby available row instead of
  // leaving it on an unmounted node.
  createEffect(() => {
    const anchor = focusAnchor();
    if (!anchor) return;
    const resolved = resolveGitStatusFocus(anchor.key, anchor.index, rows());
    if (!resolved) {
      setFocusAnchor(undefined);
      return;
    }
    if (resolved.key === anchor.key && resolved.index === anchor.index) return;
    setFocusAnchor(resolved);
    ensureRowVisible(resolved.index);
    queueMicrotask(() => focusRowElement(resolved.key));
  });

  const handleFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const rowElement = target.closest("[data-row-key]");
    const host = hostElement();
    if (!rowElement || !host?.contains(rowElement)) return;
    const key = rowElement.getAttribute("data-row-key");
    const index = rows().findIndex((row) => row.key === key);
    if (key && index >= 0) setFocusAnchor({ key, index });
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const currentRows = rows();
    if (!currentRows.length) return;
    event.preventDefault();
    const anchor = focusAnchor();
    const current = anchor ? resolveGitStatusFocus(anchor.key, anchor.index, currentRows)?.index ?? 0 : -1;
    const nextIndex = event.key === "ArrowDown" ? Math.min(current + 1, currentRows.length - 1)
      : event.key === "ArrowUp" ? Math.max(current - 1, 0)
      : event.key === "Home" ? 0
      : currentRows.length - 1;
    focusRowByIndex(nextIndex);
  };

  return (
    <>
      <Show when={rows().length}>
        <div
          class="git-status-rows"
          ref={setHostElement}
          style={{ position: "relative", height: `${window().totalHeight}px` }}
          onKeyDown={handleKeyDown}
          onFocusIn={handleFocusIn}
        >
          <For each={renderedRows()}>{(row) => {
            const index = rowIndexes().get(row.key) ?? 0;
            const item = { row, index, top: layout().offsets[index] ?? 0 };
            return <GitStatusRowItem
              item={item}
              busy={props.busy}
              onOpenDiff={props.onOpenDiff}
              onAction={props.onAction}
              onDiscard={props.onDiscard}
            />;
          }}</For>
        </div>
      </Show>
      <Show when={!props.status.files.length}>
        <div class="empty-git">{t("Working tree clean")}</div>
      </Show>
      <Show when={untracked()}>
        <div class="git-status-note"><span class="git-badge git-badge-?">?</span> {t("Untracked: Git is not tracking this file yet.")}</div>
      </Show>
    </>
  );
}

function GitStatusRowItem(props: {
  item: { row: GitStatusRow; index: number; top: number };
  busy: boolean;
  onOpenDiff: (file: GitFileStatus, staged: boolean, untrackedHint?: boolean) => void;
  onAction: (request: GitActionRequest) => void;
  onDiscard: (file: GitFileStatus) => void;
}) {
  const badge = (file: GitFileStatus, source: "staged" | "working") => file.conflict ? "U" : source === "staged" ? file.indexStatus ?? "?" : file.worktreeStatus ?? "?";
  return (
    <Show when={props.item.row.kind === "header"}
      fallback={
        <GitStatusFileRow
          item={props.item}
          busy={props.busy}
          onOpenDiff={props.onOpenDiff}
          onAction={props.onAction}
          onDiscard={props.onDiscard}
          badge={badge}
        />
      }
    >
      <GitGroupHeader
        style={{ position: "absolute", top: `${props.item.top}px`, left: "0", right: "0", height: `${GIT_STATUS_HEADER_HEIGHT}px` }}
        rowKey={props.item.row.key}
        row={props.item.row as Extract<GitStatusRow, { kind: "header" }>}
        busy={props.busy}
        onAction={props.onAction}
      />
    </Show>
  );
}

// Hint for the git_diff command — Some(true) treats the path as
// untracked, Some(false) as tracked, undefined keeps the previous behavior
// (the backend runs git status to decide).
function diffUntrackedHint(file: GitFileStatus, staged: boolean): boolean | undefined {
  if (staged) return undefined;
  return file.worktreeStatus === "?" ? true : file.worktreeStatus ? false : undefined;
}

function GitStatusFileRow(props: {
  item: { row: GitStatusRow; index: number; top: number };
  busy: boolean;
  onOpenDiff: (file: GitFileStatus, staged: boolean, untrackedHint?: boolean) => void;
  onAction: (request: GitActionRequest) => void;
  onDiscard: (file: GitFileStatus) => void;
  badge: (file: GitFileStatus, source: "staged" | "working") => string;
}) {
  const row = () => props.item.row as Extract<GitStatusRow, { kind: "file" }>;
  const title = () => row().staged ? "Staged change" : props.badge(row().file, "working") === "?" ? "Untracked file" : "Working tree change";
  return (
    <GitRow
      style={{ position: "absolute", top: `${props.item.top}px`, left: "0", right: "0" }}
      rowKey={props.item.row.key}
      file={row().file}
      badge={props.badge(row().file, row().staged ? "staged" : "working")}
      title={title()}
      busy={props.busy}
      staged={row().staged}
      onClick={() => props.onOpenDiff(row().file, row().staged, diffUntrackedHint(row().file, row().staged))}
      onStage={() => props.onAction(row().staged
        ? { action: "unstage-file", value: row().file.path, originalPath: row().file.originalPath }
        : { action: "stage-file", value: row().file.path, originalPath: row().file.originalPath })}
      onDiscard={row().staged ? undefined : () => props.onDiscard(row().file)}
    />
  );
}

function GitGroupHeader(props: { style: Record<string, string>; rowKey: string; row: Extract<GitStatusRow, { kind: "header" }>; busy: boolean; onAction: (request: GitActionRequest) => void }) {
  return (
    <div class="git-group-label" data-row-key={props.rowKey} style={props.style}>
      <span>{t(props.row.label)} <span>{props.row.count}</span></span>
      <button type="button" disabled={props.busy} onClick={() => props.onAction(props.row.group === "staged" ? { action: "unstage-all" } : { action: "add" })} title={props.row.group === "staged" ? t("Move all staged files back to Changes") : t("Stage all changes")}>{props.row.group === "staged" ? t("Unstage all") : t("Stage all")}</button>
    </div>
  );
}

function GitRow(props: { style: Record<string, string>; rowKey: string; file: GitFileStatus; badge: string; title: string; busy: boolean; staged?: boolean; onClick: () => void; onStage: () => void; onDiscard?: () => void }) {
  return (
    <div class="git-row" data-row-key={props.rowKey} style={props.style}>
      <button class="git-row-open" type="button" onClick={props.onClick} title={`${props.title} (${gitStatusLabel(props.file.indexStatus, props.file.worktreeStatus)}): ${props.file.path}`}>
        <span class={`git-badge git-badge-${props.badge}`}>{props.badge}</span>
        <span class="git-path"><span class="git-path-name">{splitDisplayPath(props.file.path).name}</span><span class="git-path-directory">{splitDisplayPath(props.file.path).directory}</span></span>
      </button>
      <div class="git-row-actions">
        <button type="button" disabled={props.busy} onClick={props.onStage} title={props.staged ? t("Unstage {path}", { path: props.file.path }) : t("Stage {path}", { path: props.file.path })} aria-label={props.staged ? t("Unstage {path}", { path: props.file.path }) : t("Stage {path}", { path: props.file.path })}><Icon name={props.staged ? "git-unstage" : "git-stage"} size={16} /></button>
        <Show when={props.onDiscard}><button type="button" class="git-row-discard" disabled={props.busy} onClick={props.onDiscard} title={t("Discard changes in {path}", { path: props.file.path })} aria-label={t("Discard changes in {path}", { path: props.file.path })}><Icon name="git-discard" size={16} /></button></Show>
      </div>
    </div>
  );
}

function GitDialogView(props: {
  dialog: GitDialog;
  branches: GitBranch[];
  currentBranch: string | null;
  commitMessage: string;
  branchName: string;
  worktreePath: string;
  selectedBranch: string;
  busy: boolean;
  onCommitMessage: (value: string) => void;
  onBranchName: (value: string) => void;
  onWorktreePath: (value: string) => void;
  onWorktreeBranchName: (value: string) => void;
  onSelectedBranch: (value: string) => void;
  onClose: () => void;
  onCommit: () => void;
  onSwitch: () => void;
  onCreateBranch: () => void;
  onDelete: () => void;
  onConfirm: () => void;
  onCreateWorktree: () => void;
}) {
  let dialogElement: HTMLElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let modalFocus: ModalFocusController | undefined;

  const focusInitialControl = () => {
    const selector = props.dialog.kind === "commit" ? "#git-commit-message"
      : props.dialog.kind === "switch" ? "#git-switch-branch"
      : props.dialog.kind === "create-branch" ? "#git-new-branch"
      : props.dialog.kind === "create-worktree" ? "#git-worktree-branch"
      : props.dialog.kind === "delete-branch" ? "#git-delete-branch"
      : ".git-dialog-cancel";
    return dialogElement?.querySelector<HTMLElement>(selector) ?? closeButton;
  };

  const handleDialogKeyDown = (event: KeyboardEvent) => {
    if (!modalFocus?.isTopmost()) return;
    modalFocus.handleKeyDown(event);
  };

  onMount(() => {
    if (dialogElement) modalFocus = activateModalFocus(dialogElement, { initialFocus: focusInitialControl });
  });

  onCleanup(() => {
    modalFocus?.dispose();
  });

  const dialogTitle = () => {
    if (props.dialog.kind === "commit") return t("Commit staged changes");
    if (props.dialog.kind === "switch") return t("Switch branch");
    if (props.dialog.kind === "create-branch") return props.dialog.commit ? t("Branch from {shortHash}", { shortHash: props.dialog.commit.shortHash }) : t("Create branch");
    if (props.dialog.kind === "create-worktree") return t("Create worktree");
    if (props.dialog.kind === "delete-branch") return t("Delete branch");
    if (props.dialog.kind === "confirm") return t("Confirm {action}", { action: actionLabel(props.dialog.request.action) });
    return props.dialog.title;
  };
  const branchCommit = () => props.dialog.kind === "create-branch" ? props.dialog.commit : undefined;
  const errorMessage = () => props.dialog.kind === "error" ? props.dialog.message : "";

  return (
    <div class="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !props.busy) props.onClose(); }}>
      <section ref={(element) => { dialogElement = element; }} classList={{ "modal": true, "git-dialog": true, "git-error-dialog": props.dialog.kind === "error" }} role="dialog" aria-modal="true" aria-labelledby="git-dialog-title" tabIndex={-1} onKeyDown={handleDialogKeyDown}>
        <div class="modal-heading">
          <div><span class="modal-kicker">{t("GIT OPERATION")}</span><h2 id="git-dialog-title">{dialogTitle()}</h2></div>
          <button ref={(element) => { closeButton = element; }} class="icon-button" onClick={props.onClose} disabled={props.busy} aria-label={t("Close dialog")}><Icon name="close" size={13} /></button>
        </div>
        <Show when={props.dialog.kind === "commit"}>
          <div class="git-dialog-body"><label for="git-commit-message">{t("Commit message")}</label><textarea id="git-commit-message" value={props.commitMessage} rows={5} placeholder={t("Describe the staged changes")} onInput={(event) => props.onCommitMessage(event.currentTarget.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); if (!props.busy) props.onCommit(); } }} /></div>
          <div class="modal-footer input-dialog-actions"><span class="modal-footnote">{t("Ctrl/Cmd + Enter to commit")}</span><div><button class="secondary-button git-dialog-cancel" onClick={props.onClose}>{t("Cancel")}</button><button class="primary-button" disabled={props.busy || !props.commitMessage.trim()} onClick={props.onCommit}>{props.busy ? t("Committing…") : t("Commit")}</button></div></div>
        </Show>
        <Show when={props.dialog.kind === "switch"}>
          <div class="git-dialog-body"><label for="git-switch-branch">{t("Branch")}</label><select id="git-switch-branch" value={props.selectedBranch} onChange={(event) => props.onSelectedBranch(event.currentTarget.value)}>{props.branches.map((branch) => <option value={branch.name}>{branch.name}{branch.current ? t(" (current)") : ""}</option>)}</select><p class="git-dialog-warning">{t("Switching branches may update files in the working tree.")}</p></div>
          <GitDialogFooter busy={props.busy} submitLabel={t("Switch")} onClose={props.onClose} onSubmit={props.onSwitch} />
        </Show>
        <Show when={props.dialog.kind === "create-branch"}>
          <div class="git-dialog-body"><label for="git-new-branch">{t("Branch name")}</label><input id="git-new-branch" autocorrect="off" autocapitalize="off" spellcheck={false} value={props.branchName} placeholder="feature/my-change" onInput={(event) => props.onBranchName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (!props.busy) props.onCreateBranch(); } }} /><Show when={branchCommit()}>{(commit) => <p class="git-dialog-context">{t("Starting point: {hash} {subject}", { hash: commit().shortHash, subject: commit().subject })}</p>}</Show></div>
          <GitDialogFooter busy={props.busy} submitLabel={props.busy ? t("Creating…") : t("Create branch")} disabled={!props.branchName.trim()} onClose={props.onClose} onSubmit={props.onCreateBranch} />
        </Show>
        <Show when={props.dialog.kind === "create-worktree"}>
          <div class="git-dialog-body">
            <label for="git-worktree-branch">{t("Branch name")}</label>
            <input id="git-worktree-branch" autocorrect="off" autocapitalize="off" spellcheck={false} value={props.branchName} placeholder="feature/my-change" onInput={(event) => props.onWorktreeBranchName(event.currentTarget.value)} />
            <label for="git-worktree-path">{t("Worktree path")}</label>
            <input id="git-worktree-path" autocorrect="off" autocapitalize="off" spellcheck={false} value={props.worktreePath} onInput={(event) => props.onWorktreePath(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (!props.busy && props.branchName.trim() && props.worktreePath.trim()) props.onCreateWorktree(); } }} />
            <p class="git-dialog-context">{t("A separate window opens after the worktree is created.")}</p>
          </div>
          <GitDialogFooter busy={props.busy} submitLabel={props.busy ? t("Creating…") : t("Create worktree")} disabled={!props.branchName.trim() || !props.worktreePath.trim()} onClose={props.onClose} onSubmit={props.onCreateWorktree} />
        </Show>
        <Show when={props.dialog.kind === "delete-branch"}>
          <div class="git-dialog-body"><label for="git-delete-branch">{t("Branch")}</label><select id="git-delete-branch" value={props.selectedBranch} onChange={(event) => props.onSelectedBranch(event.currentTarget.value)}>{props.branches.filter((branch) => !branch.current).map((branch) => <option value={branch.name}>{branch.name}</option>)}</select><p class="git-dialog-warning">{t("Delete local branch {branch}? Commits unique to this branch may become hard to recover.", { branch: props.selectedBranch })}</p></div>
          <GitDialogFooter busy={props.busy} submitLabel={t("Delete branch")} danger={!props.busy} disabled={!props.selectedBranch} onClose={props.onClose} onSubmit={props.onDelete} />
        </Show>
        <Show when={props.dialog.kind === "confirm" ? props.dialog : undefined}>{(confirmation) => <>
          <div class="git-dialog-body">
            <p class="git-dialog-warning">{confirmation().message}</p>
            <Show when={confirmation().request.action === "commit-all"}><div class="git-quick-commit-confirm-message"><span>{t("Commit message")}</span><pre>{confirmation().request.message}</pre></div><p>{t("Continue with stage all and commit?")}</p></Show>
          </div>
          <GitDialogFooter busy={props.busy} submitLabel={actionLabel(confirmation().request.action)} danger={!props.busy} onClose={props.onClose} onSubmit={props.onConfirm} />
        </>}</Show>
        <Show when={props.dialog.kind === "error"}>
          <div class="git-error-body"><p>{errorMessage()}</p></div>
          <div class="modal-footer input-dialog-actions"><button class="primary-button" onClick={props.onClose}>{t("Close")}</button></div>
        </Show>
      </section>
    </div>
  );
}

function GitDialogFooter(props: { busy: boolean; submitLabel: string; disabled?: boolean; danger?: boolean; onClose: () => void; onSubmit: () => void }) {
  return <div class="modal-footer input-dialog-actions"><button class="secondary-button git-dialog-cancel" onClick={props.onClose}>{t("Cancel")}</button><button classList={{ "primary-button": true, "danger-button": props.danger }} disabled={props.busy || props.disabled} onClick={props.onSubmit}>{props.submitLabel}</button></div>;
}
