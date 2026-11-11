import { For, Index, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "./Icons";
import { buildGitGraph, type GitGraphRow, type GitGraphSegment } from "../lib/git-graph";
import { reconcileGitHistoryBranchFilter, type GitHistoryBranchFilter } from "../lib/git-history-filter";
import {
  GIT_HISTORY_FULL_ROW_HEIGHT,
  GIT_HISTORY_PREFETCH_ROWS,
  GIT_HISTORY_ROW_HEIGHT,
  gitHistoryRenderWindow,
  sameGitHistoryRenderWindow,
} from "../lib/git-history-virtualization";
import { relativeTimeLabel } from "../lib/relative-time";
import type { GitBranch, GitCommit, GitCommitFile } from "../types";
import "../styles/git-history.css";
import { t } from "../lib/i18n";

type BranchFilter = GitHistoryBranchFilter;
type HistoryBranch = {
  value: BranchFilter;
  name: string;
  kind: "local" | "remote";
  tipHash?: string;
  current: boolean;
};
type CommitTooltip = {
  commit: GitCommit;
  boundary: boolean;
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

type GitHistoryProps = {
  repositoryRoot: string;
  branches: GitBranch[];
  commits: GitCommit[];
  headOid?: string | null;
  currentBranch: string | null;
  repositoryState: "normal" | "detached" | "unborn" | "unknown";
  loading: boolean;
  error?: string | null;
  fullMode?: boolean;
  commitFiles: Record<string, GitCommitFile[]>;
  commitLoadErrors: Record<string, string>;
  isLoading: (hash: string) => boolean;
  onLoadFiles: (commit: GitCommit) => void;
  onOpenDiff: (commit: GitCommit, file: GitCommitFile) => void;
  onCreateBranch: (commit?: GitCommit) => void;
  onRefresh: () => void;
  onOpenHistory?: () => void;
  historyHasMore: boolean;
  historyLoadingMore: boolean;
  onLoadMoreHistory: () => void;
};

const LANE_SPACING = 14;
const TOOLTIP_OPEN_DELAY_MS = 400;
const TOOLTIP_CLOSE_DELAY_MS = 180;
const searchTextByCommit = new WeakMap<GitCommit, string>();

export function GitHistory(props: GitHistoryProps) {
  const [branchFilter, setBranchFilter] = createSignal<BranchFilter>("all");
  const [selectedHash, setSelectedHash] = createSignal<string>();
  const [searchCursorHash, setSearchCursorHash] = createSignal<string>();
  const [search, setSearch] = createSignal("");
  const [copyMessage, setCopyMessage] = createSignal("");
  const [tooltip, setTooltip] = createSignal<CommitTooltip>();
  const [focusedHash, setFocusedHash] = createSignal<string>();
  const rowElements = new Map<string, HTMLButtonElement>();
  const tooltipId = createUniqueId();
  const overlayRoot = document.querySelector<HTMLElement>(".app-shell") ?? document.body;
  let previousRepositoryRoot = props.repositoryRoot;
  let searchInput: HTMLInputElement | undefined;
  const [tableElement, setTableElement] = createSignal<HTMLDivElement>();
  const [listElement, setListElement] = createSignal<HTMLDivElement>();
  let scrollHost: HTMLDivElement | undefined;
  let detachScrollHost = () => {};
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [listOffset, setListOffset] = createSignal(0);
  let copyMessageTimer: ReturnType<typeof setTimeout> | undefined;
  let tooltipOpenTimer: ReturnType<typeof setTimeout> | undefined;
  let tooltipCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressedFocusedTooltipHash: string | undefined;

  // Reading these props subscribes to the whole Git status, which changes on
  // every refresh. Memos keep unchanged commits from recomputing what follows.
  const commits = createMemo(() => props.commits);
  const branches = createMemo(() => props.branches);
  const rowHeight = () => (props.fullMode ? GIT_HISTORY_FULL_ROW_HEIGHT : GIT_HISTORY_ROW_HEIGHT);
  const commitByHash = createMemo(() => new Map(commits().map((commit) => [commit.hash, commit])));
  const headCommit = createMemo(() => {
    const exactHead = props.headOid ? commitByHash().get(props.headOid) : undefined;
    if (exactHead) return exactHead;
    return commits().find((commit) =>
      commit.refs.some((reference) => reference === "HEAD" || reference.startsWith("HEAD -> ")),
    );
  });
  const currentBranchName = () => props.currentBranch ?? branches().find((branch) => branch.current)?.name ?? "";
  const branchOptions = createMemo(() => historyBranchOptions(commits(), branches(), currentBranchName()), undefined, {
    equals: sameBranchOptions,
  });
  const localBranchOptions = createMemo(() => branchOptions().filter((branch) => branch.kind === "local"));
  const remoteBranchOptions = createMemo(() => branchOptions().filter((branch) => branch.kind === "remote"));
  const localBranchNames = createMemo<ReadonlySet<string>>(() => new Set(branches().map((branch) => branch.name)));
  const availableBranchFilters = createMemo(() => {
    const options = branchOptions().map((branch) => ({ value: branch.value }));
    if (props.repositoryState === "detached") options.push({ value: "current-head" as BranchFilter });
    return options;
  });
  const commitsReachableFrom = (startHash?: string) => {
    if (!startHash) return [];
    const reachable = new Set<string>();
    const pending = [startHash];
    while (pending.length) {
      const hash = pending.pop()!;
      if (reachable.has(hash)) continue;
      const commit = commitByHash().get(hash);
      if (!commit) continue;
      reachable.add(hash);
      for (let index = (commit.parents?.length ?? 0) - 1; index >= 0; index -= 1) {
        const parent = commit.parents?.[index];
        if (parent && !reachable.has(parent)) pending.push(parent);
      }
    }
    return commits().filter((commit) => reachable.has(commit.hash));
  };

  const visibleCommits = createMemo(() => {
    const selected = branchFilter();
    if (selected === "all") return commits();
    if (selected === "current-head") return commitsReachableFrom(headCommit()?.hash);
    const branch = branchOptions().find((option) => option.value === selected);
    const startHash = branch?.current ? (headCommit()?.hash ?? branch.tipHash) : branch?.tipHash;
    return commitsReachableFrom(startHash);
  });
  const graph = createMemo(() => buildGitGraph(visibleCommits()));
  const graphEntries = createMemo(() => new Map(graph().rows.map((row, index) => [row.commit.hash, { row, index }])));
  const renderWindow = createMemo(
    () => {
      const focused = focusedHash();
      return gitHistoryRenderWindow(
        graph().rows.length,
        Math.max(0, scrollTop() - listOffset()),
        viewportHeight(),
        focused ? (graphEntries().get(focused)?.index ?? -1) : -1,
        rowHeight(),
      );
    },
    undefined,
    { equals: sameGitHistoryRenderWindow },
  );
  // Rows are keyed by commit hash so a rebuilt graph updates mounted rows in
  // place: they keep their DOM and keyboard focus when another page arrives.
  const renderedHashes = createMemo(() => {
    const rows = graph().rows;
    return renderWindow().indexes.flatMap((index) => (rows[index] ? [rows[index].commit.hash] : []));
  });
  const historyContentHeight = () => graph().rows.length * rowHeight() + (props.historyHasMore ? 46 : 0);
  // Load the next page before the viewport reaches the end of the loaded rows. A
  // page that adds no visible rows (hidden by the branch filter) stops the
  // automatic loading; the Load older commits button continues it.
  let autoLoadedRowCount = -1;
  createEffect(() => {
    const rowCount = graph().rows.length;
    const viewport = viewportHeight();
    const remaining = rowCount * rowHeight() - (Math.max(0, scrollTop() - listOffset()) + viewport);
    if (
      !props.historyHasMore ||
      props.loading ||
      props.historyLoadingMore ||
      !viewport ||
      remaining > rowHeight() * GIT_HISTORY_PREFETCH_ROWS
    )
      return;
    if (rowCount === autoLoadedRowCount) return;
    autoLoadedRowCount = rowCount;
    props.onLoadMoreHistory();
  });
  const railWidth = createMemo(() => {
    const laneCount = Math.max(1, graph().laneCount);
    const [minimum, maximum] = props.fullMode ? [46, 220] : [30, 86];
    return Math.min(maximum, Math.max(minimum, laneCount * LANE_SPACING + 4));
  });
  const selectedCommit = createMemo(() => {
    const hash = selectedHash();
    return hash ? commitByHash().get(hash) : undefined;
  });
  const isSelected = (hash: string) => selectedHash() === hash;
  const hasOpenTooltip = (hash: string) => tooltip()?.commit.hash === hash;
  const filesFor = (commit: GitCommit) =>
    Object.hasOwn(props.commitFiles, commit.hash) ? props.commitFiles[commit.hash] : commit.files;
  const hasUnknownParents = createMemo(() => commits().some((commit) => commit.parents === undefined));
  const searchMatches = createMemo(() => {
    const query = search().trim().toLocaleLowerCase();
    if (!query) return [];
    return visibleCommits().filter((commit) => commitSearchText(commit).includes(query));
  });
  const searchMatchLabel = createMemo(() => {
    const matches = searchMatches();
    const cursor = searchCursorHash();
    const position = cursor ? matches.findIndex((commit) => commit.hash === cursor) : -1;
    return position >= 0 ? `${position + 1}/${matches.length}` : String(matches.length);
  });

  createEffect(() => {
    search();
    setSearchCursorHash(undefined);
  });
  createEffect(() => {
    const reconciliation = reconcileGitHistoryBranchFilter({
      selected: branchFilter(),
      previousRepositoryRoot,
      repositoryRoot: props.repositoryRoot,
      loading: props.loading,
      options: availableBranchFilters(),
    });
    previousRepositoryRoot = reconciliation.repositoryRoot;
    if (reconciliation.selected !== branchFilter()) setBranchFilter(reconciliation.selected);
  });
  createEffect(() => {
    const hash = selectedHash();
    if (hash && !graphEntries().has(hash)) setSelectedHash(undefined);
  });

  const cancelTooltipOpen = () => {
    clearTimeout(tooltipOpenTimer);
    tooltipOpenTimer = undefined;
  };
  const cancelTooltipClose = () => {
    clearTimeout(tooltipCloseTimer);
    tooltipCloseTimer = undefined;
  };
  const closeTooltip = () => {
    cancelTooltipOpen();
    cancelTooltipClose();
    setTooltip(undefined);
  };
  const scheduleTooltipClose = () => {
    cancelTooltipOpen();
    cancelTooltipClose();
    tooltipCloseTimer = setTimeout(() => {
      const activeTooltip = tooltip();
      const focusedRow = activeTooltip && rowElements.get(activeTooltip.commit.hash);
      const focused =
        focusedRow &&
        focusedRow === document.activeElement &&
        focusedRow.matches(":focus-visible") &&
        suppressedFocusedTooltipHash !== activeTooltip.commit.hash;
      if (!focused) setTooltip(undefined);
    }, TOOLTIP_CLOSE_DELAY_MS);
  };
  const measureViewport = () => {
    if (!scrollHost) return;
    const list = listElement();
    setListOffset(
      list && list !== scrollHost
        ? list.getBoundingClientRect().top - scrollHost.getBoundingClientRect().top + scrollHost.scrollTop
        : 0,
    );
    setScrollTop(scrollHost.scrollTop);
    setViewportHeight(scrollHost.clientHeight);
  };
  createEffect(() => {
    // The history table is conditional, so the first mount can happen before
    // Git returns its initial page. Ref signals and content height both cause
    // this effect to attach the active scroll host and measure it again.
    historyContentHeight();
    const element = props.fullMode ? tableElement() : listElement();
    const host = element?.isConnected ? element : undefined;
    if (host !== scrollHost) {
      detachScrollHost();
      scrollHost = host;
      if (host) {
        const handleScroll = () => setScrollTop(host.scrollTop);
        host.addEventListener("scroll", handleScroll, { passive: true });
        const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measureViewport);
        resizeObserver?.observe(host);
        detachScrollHost = () => {
          host.removeEventListener("scroll", handleScroll);
          resizeObserver?.disconnect();
          detachScrollHost = () => {};
        };
      }
    }
    measureViewport();
  });
  onMount(() => {
    const closeOnScroll = (event: Event) => {
      if (event.target instanceof Node && document.getElementById(tooltipId)?.contains(event.target)) return;
      closeTooltip();
    };
    window.addEventListener("scroll", closeOnScroll, { capture: true, passive: true });
    window.addEventListener("resize", closeTooltip);
    onCleanup(() => {
      window.removeEventListener("scroll", closeOnScroll, { capture: true });
      window.removeEventListener("resize", closeTooltip);
    });
  });
  onCleanup(() => {
    clearTimeout(copyMessageTimer);
    closeTooltip();
    detachScrollHost();
  });

  const showTooltip = (commit: GitCommit, row: HTMLButtonElement, boundary: boolean) => {
    cancelTooltipOpen();
    cancelTooltipClose();
    const bounds = row.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const tableBounds = row.closest<HTMLElement>(".git-history-table")?.getBoundingClientRect();
    const listBounds = row.closest<HTMLElement>(".git-history-list")?.getBoundingClientRect();
    const areaTop = Math.max(8, tableBounds?.top ?? 8, listBounds?.top ?? 8);
    const areaBottom = Math.min(
      viewportHeight - 8,
      tableBounds?.bottom ?? viewportHeight - 8,
      listBounds?.bottom ?? viewportHeight - 8,
    );
    const width = Math.max(220, Math.min(360, viewportWidth - 16));
    const maxHeight = Math.max(64, Math.min(420, viewportHeight - 16, areaBottom - areaTop - 8));
    const left = Math.max(8, Math.min(bounds.right + 8, viewportWidth - width - 8));
    let top = bounds.bottom + 6;
    if (top + maxHeight > areaBottom - 4) top = bounds.top - maxHeight - 6;
    top = Math.max(areaTop + 4, Math.min(top, areaBottom - maxHeight - 4));
    setTooltip({ commit, boundary, left, top, width, maxHeight });
  };
  // A pointer crossing rows opens nothing until it rests on one; once a tooltip
  // is open, moving to the next row switches right away.
  const showTooltipOnHover = (commit: GitCommit, row: HTMLButtonElement, boundary: boolean) => {
    cancelTooltipOpen();
    cancelTooltipClose();
    if (tooltip()) {
      showTooltip(commit, row, boundary);
      return;
    }
    tooltipOpenTimer = setTimeout(() => {
      if (row.isConnected) showTooltip(commit, row, boundary);
    }, TOOLTIP_OPEN_DELAY_MS);
  };

  const ensureCommitFiles = (commit: GitCommit) => {
    if (
      Object.hasOwn(props.commitFiles, commit.hash) ||
      commit.files.length ||
      props.isLoading(commit.hash) ||
      props.commitLoadErrors[commit.hash]
    )
      return;
    props.onLoadFiles(commit);
  };

  const scrollToCommit = (hash: string) => {
    const index = graphEntries().get(hash)?.index;
    if (index === undefined) return;
    if (scrollHost) {
      const rowTop = index * rowHeight();
      const rowBottom = rowTop + rowHeight();
      const viewportTop = scrollHost.scrollTop - listOffset();
      let target = scrollHost.scrollTop;
      if (rowTop < viewportTop) target = listOffset() + rowTop;
      else if (rowBottom > viewportTop + viewportHeight()) target = listOffset() + rowBottom - viewportHeight();
      target = Math.min(Math.max(0, target), Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight));
      if (target !== scrollHost.scrollTop) {
        scrollHost.scrollTop = target;
        setScrollTop(target);
      }
    }
    requestAnimationFrame(() => {
      const row = rowElements.get(hash);
      if (!row) return;
      row.focus({ preventScroll: true });
    });
  };

  const selectCommit = (commit: GitCommit) => {
    closeTooltip();
    if (selectedHash() === commit.hash) {
      setSelectedHash(undefined);
      return;
    }
    setSelectedHash(commit.hash);
    ensureCommitFiles(commit);
  };

  const moveSelection = (commit: GitCommit, offset: number) => {
    const rows = graph().rows;
    const index = graphEntries().get(commit.hash)?.index ?? 0;
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + offset))];
    if (next) scrollToCommit(next.commit.hash);
  };

  const moveToHistoryBoundary = (boundary: "first" | "last") => {
    const commits = visibleCommits();
    const commit = boundary === "first" ? commits[0] : commits[commits.length - 1];
    if (commit) scrollToCommit(commit.hash);
  };

  const jumpToHead = () => {
    const head = headCommit();
    if (!head) {
      setCopyMessage(t("HEAD is not in the loaded history"));
      clearTimeout(copyMessageTimer);
      copyMessageTimer = setTimeout(() => setCopyMessage(""), 2200);
      return;
    }
    if (!graphEntries().has(head.hash)) setBranchFilter("all");
    scrollToCommit(head.hash);
  };

  const jumpToSearchMatch = (direction = 1) => {
    const matches = searchMatches();
    if (!matches.length) return;
    const currentIndex = matches.findIndex((commit) => commit.hash === searchCursorHash());
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + matches.length) % matches.length;
    const commit = matches[nextIndex];
    setSearchCursorHash(commit.hash);
    scrollToCommit(commit.hash);
  };

  const copyHash = async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopyMessage(t("Hash copied"));
    } catch {
      setCopyMessage(t("Clipboard is unavailable"));
    }
    clearTimeout(copyMessageTimer);
    copyMessageTimer = setTimeout(() => setCopyMessage(""), 1800);
  };

  const setBranchChoice = (value: string) => setBranchFilter(value as BranchFilter);

  return (
    <section
      classList={{ "git-history": true, "git-history-full": Boolean(props.fullMode) }}
      aria-label={t("Git history")}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
          event.preventDefault();
          searchInput?.focus();
          searchInput?.select();
        }
      }}
    >
      <div class="git-history-toolbar">
        <div class="git-history-tools">
          <label class="git-history-filter">
            <span class="git-history-sr-only">{t("Filter commits by branch")}</span>
            <select
              value={branchFilter()}
              onChange={(event) => setBranchChoice(event.currentTarget.value)}
              aria-label={t("Filter commits by branch")}
            >
              <option value="all">{t("All branches")}</option>
              <Show when={props.repositoryState === "detached"}>
                <option value="current-head">{t("Current HEAD")}</option>
              </Show>
              <Show when={!branchOptions().length}>
                <option value="all" disabled>
                  {t("No branch refs available")}
                </option>
              </Show>
              <Show when={localBranchOptions().length}>
                <optgroup label={t("Local branches")}>
                  <For each={localBranchOptions()}>
                    {(branch) => (
                      <option value={branch.value}>
                        {branch.name}
                        {branch.current ? t(" · HEAD") : ""}
                      </option>
                    )}
                  </For>
                </optgroup>
              </Show>
              <Show when={remoteBranchOptions().length}>
                <optgroup label={t("Remote branches")}>
                  <For each={remoteBranchOptions()}>
                    {(branch) => <option value={branch.value}>{branch.name}</option>}
                  </For>
                </optgroup>
              </Show>
            </select>
          </label>
        </div>
        <div class="git-history-tools git-history-tools-right">
          <label class="git-history-search">
            <Icon name="search" size={12} />
            <input
              ref={searchInput}
              autocorrect="off"
              autocapitalize="off"
              spellcheck={false}
              value={search()}
              onInput={(event) => setSearch(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  jumpToSearchMatch(event.shiftKey ? -1 : 1);
                }
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setSearch("");
                  searchInput?.blur();
                }
              }}
              placeholder={t("Search history")}
              aria-label={t("Search history; Enter jumps to a match")}
            />
            <Show when={search().trim()}>
              <span class="git-history-match-count">{searchMatchLabel()}</span>
            </Show>
          </label>
          <div class="git-history-toolbar-actions">
            <button
              class="git-history-icon-button"
              type="button"
              title={t("Locate current HEAD")}
              aria-label={t("Locate current HEAD")}
              onClick={jumpToHead}
            >
              <span class="git-history-head-icon">●</span>
            </button>
            <button
              class="git-history-icon-button"
              type="button"
              title={t("Refresh history")}
              aria-label={t("Refresh history")}
              onClick={props.onRefresh}
            >
              <Icon name="refresh" size={13} />
            </button>
            <Show when={props.onOpenHistory}>
              <button
                class="git-history-icon-button git-history-expand"
                type="button"
                title={t("Open full history")}
                aria-label={t("Open full history")}
                onClick={props.onOpenHistory}
              >
                <Icon name="external" size={13} />
              </button>
            </Show>
          </div>
        </div>
        <Show when={props.loading}>
          <div class="git-history-progress" role="status" aria-label={t("Refreshing history…")} />
        </Show>
      </div>

      <Show when={props.error}>
        <div class="git-history-error" role="alert">
          {props.error}
        </div>
      </Show>
      <Show when={hasUnknownParents()}>
        <div class="git-history-note" role="note">
          {t("Some commits have unavailable parent data; dotted nodes mark incomplete ancestry.")}
        </div>
      </Show>
      <Show when={copyMessage()}>
        <div class="git-history-feedback" role="status">
          {copyMessage()}
        </div>
      </Show>
      <Show when={search().trim() && !searchMatches().length}>
        <div class="git-history-search-empty" role="status">
          {t("No commits match “{query}”. The history rows remain visible.", { query: search().trim() })}
        </div>
      </Show>

      <Show
        when={visibleCommits().length}
        fallback={
          <div class="git-history-empty">
            {props.loading
              ? t("Loading commit history…")
              : commits().length
                ? t("No history found for the selected branches")
                : t("No commit history")}
          </div>
        }
      >
        <div
          class="git-history-table"
          ref={setTableElement}
          style={{ "--history-rail-width": `${railWidth()}px`, "--history-row-height": `${rowHeight()}px` }}
        >
          <Show when={props.fullMode}>
            <div class="git-history-column-header">
              <span>{t("GRAPH")}</span>
              <span>{t("MESSAGE")}</span>
              <span>{t("AUTHOR")}</span>
              <span>{t("DATE")}</span>
              <span>{t("HASH")}</span>
            </div>
          </Show>
          <div
            class="git-history-list"
            ref={setListElement}
            role="list"
            aria-label={t("Commits")}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                const activeHash = (document.activeElement as HTMLElement | null)?.dataset?.commitHash;
                if (activeHash) suppressedFocusedTooltipHash = activeHash;
                closeTooltip();
                setSelectedHash(undefined);
              }
            }}
          >
            <div class="git-history-rows" style={{ position: "relative", height: `${historyContentHeight()}px` }}>
              <For each={renderedHashes()}>
                {(hash) => {
                  // A hash leaving the graph keeps its last row until For disposes it.
                  const entry = createMemo(
                    (previous: { row: GitGraphRow; index: number }) => graphEntries().get(hash) ?? previous,
                    graphEntries().get(hash)!,
                  );
                  const row = () => entry().row;
                  const commit = createMemo(() => row().commit);
                  const rowRef = (element: HTMLButtonElement) => {
                    rowElements.set(hash, element);
                    onCleanup(() => rowElements.delete(hash));
                  };
                  const references = createMemo(() => commitReferences(commit(), localBranchNames()));
                  const visibleReferenceCount = () => (props.fullMode ? 4 : 2);
                  return (
                    <div
                      classList={{
                        "git-history-row-wrap": true,
                        "git-history-row-selected": isSelected(hash),
                        "git-history-row-boundary": row().hasHiddenParents,
                      }}
                      style={{ position: "absolute", top: `${entry().index * rowHeight()}px`, left: "0", right: "0" }}
                      role="listitem"
                    >
                      <button
                        ref={rowRef}
                        class="git-history-row"
                        type="button"
                        data-commit-hash={hash}
                        aria-current={isSelected(hash) ? "true" : undefined}
                        aria-describedby={hasOpenTooltip(hash) ? tooltipId : undefined}
                        aria-label={`${commit().subject}, ${commit().author}, ${commit().date}, ${commit().shortHash}${row().hasHiddenParents ? ", history boundary" : ""}`}
                        onMouseEnter={(event) =>
                          showTooltipOnHover(commit(), event.currentTarget, row().hasHiddenParents)
                        }
                        onMouseLeave={(event) => {
                          if (event.currentTarget.matches(":focus-visible") && suppressedFocusedTooltipHash !== hash)
                            showTooltip(commit(), event.currentTarget, row().hasHiddenParents);
                          else scheduleTooltipClose();
                        }}
                        onFocus={(event) => {
                          setFocusedHash(hash);
                          suppressedFocusedTooltipHash = undefined;
                          if (event.currentTarget.matches(":focus-visible"))
                            showTooltip(commit(), event.currentTarget, row().hasHiddenParents);
                        }}
                        onBlur={(event) => {
                          if (focusedHash() === hash) setFocusedHash(undefined);
                          if (
                            !event.currentTarget.matches(":hover") &&
                            !event.currentTarget.contains(event.relatedTarget as Node | null)
                          )
                            scheduleTooltipClose();
                        }}
                        onClick={() => {
                          suppressedFocusedTooltipHash = hash;
                          selectCommit(commit());
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowDown") {
                            event.preventDefault();
                            moveSelection(commit(), 1);
                          }
                          if (event.key === "ArrowUp") {
                            event.preventDefault();
                            moveSelection(commit(), -1);
                          }
                          if (event.key === "Home") {
                            event.preventDefault();
                            moveToHistoryBoundary("first");
                          }
                          if (event.key === "End") {
                            event.preventDefault();
                            moveToHistoryBoundary("last");
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            suppressedFocusedTooltipHash = hash;
                            closeTooltip();
                            setSelectedHash(undefined);
                          }
                        }}
                      >
                        <GitGraphRail
                          row={row()}
                          laneCount={graph().laneCount}
                          width={railWidth()}
                          height={rowHeight()}
                        />
                        <span class="git-history-columns">
                          <span class="git-history-message">
                            <span class="git-history-subject" title={commit().subject}>
                              <HighlightedText value={commit().subject} query={search()} />
                            </span>
                            <span
                              class="git-history-ref-list"
                              aria-label={
                                commit().refs.length
                                  ? t("References: {value}", { value: commit().refs.join(", ") })
                                  : undefined
                              }
                            >
                              <For each={references().slice(0, visibleReferenceCount())}>
                                {(reference) => (
                                  <span
                                    class={`git-history-ref git-history-ref-${reference.kind}`}
                                    title={`${reference.kind}: ${reference.label}`}
                                  >
                                    {reference.label}
                                  </span>
                                )}
                              </For>
                              <Show when={references().length > visibleReferenceCount()}>
                                <span
                                  class="git-history-ref-more"
                                  title={references()
                                    .slice(visibleReferenceCount())
                                    .map((reference) => reference.label)
                                    .join(", ")}
                                >
                                  +{references().length - visibleReferenceCount()}
                                </span>
                              </Show>
                            </span>
                            <Show when={!props.fullMode}>
                              <span class="git-history-meta" title={commit().authoredAt ?? commit().date}>
                                <HighlightedText
                                  value={`${commit().shortHash} · ${commit().author} · ${relativeCommitAge(commit())}`}
                                  query={search()}
                                />
                              </span>
                            </Show>
                          </span>
                          <Show when={props.fullMode}>
                            <span class="git-history-author" title={commit().author}>
                              <HighlightedText value={commit().author} query={search()} />
                            </span>
                            <span class="git-history-date" title={commit().authoredAt ?? commit().date}>
                              <HighlightedText value={commit().date} query={search()} />
                            </span>
                            <span class="git-history-hash" title={commit().hash}>
                              <HighlightedText value={commit().shortHash} query={search()} />
                            </span>
                          </Show>
                        </span>
                      </button>
                    </div>
                  );
                }}
              </For>
              <Show when={props.historyHasMore}>
                <div
                  class="git-history-load-more"
                  style={{ position: "absolute", top: `${graph().rows.length * rowHeight()}px`, left: "0", right: "0" }}
                >
                  <button
                    type="button"
                    disabled={props.loading || props.historyLoadingMore}
                    onClick={() => {
                      if (!props.loading && !props.historyLoadingMore) props.onLoadMoreHistory();
                    }}
                  >
                    {props.historyLoadingMore ? t("Loading older commits…") : t("Load older commits")}
                  </button>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={selectedCommit()}>
        {(commit) => (
          <CommitDetails
            commit={commit()}
            loading={props.isLoading(commit().hash)}
            error={props.commitLoadErrors[commit().hash]}
            files={filesFor(commit())}
            loaded={Object.hasOwn(props.commitFiles, commit().hash) || Boolean(commit().files.length)}
            onCopy={copyHash}
            onRetry={props.onLoadFiles}
            onCreateBranch={props.onCreateBranch}
            onOpenDiff={props.onOpenDiff}
            onClose={() => setSelectedHash(undefined)}
          />
        )}
      </Show>
      <Show when={tooltip()}>
        {(active) => (
          <Portal mount={overlayRoot}>
            <CommitMetadataTooltip
              id={tooltipId}
              commit={active().commit}
              boundary={active().boundary}
              left={active().left}
              top={active().top}
              width={active().width}
              maxHeight={active().maxHeight}
              onMouseEnter={cancelTooltipClose}
              onMouseLeave={scheduleTooltipClose}
            />
          </Portal>
        )}
      </Show>
    </section>
  );
}

type CommitReference = { kind: "head" | "local" | "remote" | "tag"; label: string };

function historyBranchOptions(commits: GitCommit[], branches: GitBranch[], currentBranch: string): HistoryBranch[] {
  const localNames = new Set(branches.map((branch) => branch.name));
  const currentName = currentBranch || branches.find((branch) => branch.current)?.name || "";
  const options = new Map<string, HistoryBranch>();
  const addBranch = (kind: "local" | "remote", name: string, tipHash?: string, current = false) => {
    if (!name) return;
    const value = `branch:${kind}:${name}` as BranchFilter;
    const existing = options.get(value);
    options.set(value, {
      value,
      name,
      kind,
      tipHash: existing?.tipHash ?? tipHash,
      current: Boolean(existing?.current || current || (kind === "local" && name === currentName)),
    });
  };

  for (const branch of branches) addBranch("local", branch.name, undefined, branch.current);
  for (const commit of commits) {
    for (const reference of commit.refs) {
      if (reference.startsWith("HEAD -> ")) {
        addBranch("local", reference.slice("HEAD -> ".length), commit.hash, true);
        continue;
      }
      const parsed = parseBranchReference(reference, localNames);
      if (parsed) addBranch(parsed.kind, parsed.name, commit.hash);
    }
  }

  if (currentName) addBranch("local", currentName);
  return [...options.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "local" ? -1 : 1;
    if (left.current !== right.current) return left.current ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function sameBranchOptions(left: HistoryBranch[], right: HistoryBranch[]): boolean {
  return (
    left.length === right.length &&
    left.every((branch, index) => {
      const other = right[index];
      return branch.value === other.value && branch.tipHash === other.tipHash && branch.current === other.current;
    })
  );
}

function commitSearchText(commit: GitCommit): string {
  let text = searchTextByCommit.get(commit);
  if (text === undefined) {
    text = [
      commit.subject,
      commit.body ?? "",
      commit.author,
      commit.date,
      commit.authoredAt ?? "",
      commit.hash,
      commit.refs.join(" "),
    ]
      .join("\n")
      .toLocaleLowerCase();
    searchTextByCommit.set(commit, text);
  }
  return text;
}

function parseBranchReference(
  reference: string,
  localNames: ReadonlySet<string>,
): { kind: "local" | "remote"; name: string } | undefined {
  if (reference === "HEAD" || reference.startsWith("tag: ") || reference.startsWith("refs/tags/")) return undefined;
  if (reference.startsWith("refs/heads/")) return { kind: "local", name: reference.slice("refs/heads/".length) };
  if (reference.startsWith("refs/remotes/")) return { kind: "remote", name: reference.slice("refs/remotes/".length) };
  if (reference.startsWith("remotes/")) return { kind: "remote", name: reference.slice("remotes/".length) };
  if (localNames.has(reference)) return { kind: "local", name: reference };
  return { kind: "remote", name: reference };
}

function commitReferences(commit: GitCommit, localBranches: ReadonlySet<string>): CommitReference[] {
  const references: CommitReference[] = [];
  for (const reference of commit.refs) {
    if (reference === "HEAD") {
      references.push({ kind: "head", label: "HEAD" });
    } else if (reference.startsWith("HEAD -> ")) {
      references.push({ kind: "head", label: "HEAD" });
      const branchName = reference.slice("HEAD -> ".length);
      if (branchName) references.push({ kind: "local", label: branchName });
    } else if (reference.startsWith("tag: ") || reference.startsWith("refs/tags/")) {
      references.push({ kind: "tag", label: reference.replace(/^tag: /, "").replace(/^refs\/tags\//, "") });
    } else {
      const branch = parseBranchReference(reference, localBranches);
      if (branch) references.push({ kind: branch.kind, label: branch.name });
    }
  }
  const keys = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.kind}:${reference.label}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function CommitMetadataTooltip(props: {
  id: string;
  commit: GitCommit;
  boundary: boolean;
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const parents = () =>
    props.commit.parents === undefined
      ? t("Parent data unavailable")
      : props.commit.parents.length
        ? props.commit.parents.join(", ")
        : t("Root commit");
  return (
    <div
      class="git-history-tooltip"
      id={props.id}
      role="tooltip"
      style={{
        left: `${props.left}px`,
        top: `${props.top}px`,
        width: `${props.width}px`,
        "max-height": `${props.maxHeight}px`,
      }}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    >
      <strong class="git-history-tooltip-subject">{props.commit.subject}</strong>
      <Show when={props.commit.body}>
        <p class="git-history-tooltip-body">{props.commit.body}</p>
      </Show>
      <dl class="git-history-tooltip-fields">
        <dt>{t("Author")}</dt>
        <dd>{props.commit.author}</dd>
        <dt>{t("Date")}</dt>
        <dd>{props.commit.authoredAt ?? props.commit.date}</dd>
        <dt>{t("Hash")}</dt>
        <dd>
          <code>{props.commit.hash}</code>
        </dd>
        <dt>{t("Parents")}</dt>
        <dd>{parents()}</dd>
        <dt>{t("Refs")}</dt>
        <dd>{props.commit.refs.length ? props.commit.refs.join(", ") : t("None")}</dd>
      </dl>
      <Show when={props.boundary}>
        <p class="git-history-tooltip-note">{t("A parent of this commit is outside the loaded history.")}</p>
      </Show>
    </div>
  );
}

function relativeCommitAge(commit: GitCommit): string {
  return relativeTimeLabel(commit.authoredAt ?? commit.date);
}

function GitGraphRail(props: { row: GitGraphRow; laneCount: number; width: number; height: number }) {
  const laneTotal = () => Math.max(1, props.laneCount);
  // Lanes compress only when they no longer fit the capped rail width.
  const laneSpacing = () => (laneTotal() <= 1 ? 0 : Math.min(LANE_SPACING, (props.width - 14) / (laneTotal() - 1)));
  const x = (lane: number) => 7 + lane * laneSpacing();
  const y = (fraction: number) => fraction * props.height;
  const segmentPath = (segment: GitGraphSegment) => {
    const fromX = x(segment.fromLane);
    const toX = x(segment.toLane);
    const fromY = y(segment.fromY);
    const toY = y(segment.toY);
    if (segment.fromLane === segment.toLane) return `M ${fromX} ${fromY} L ${toX} ${toY}`;
    const middleY = (fromY + toY) / 2;
    return `M ${fromX} ${fromY} C ${fromX} ${middleY} ${toX} ${middleY} ${toX} ${toY}`;
  };
  return (
    <svg
      class="git-history-graph"
      width={props.width}
      height={props.height}
      viewBox={`0 0 ${props.width} ${props.height}`}
      aria-hidden="true"
    >
      <Index each={props.row.segments}>
        {(segment) => (
          <path
            classList={{ "git-history-segment": true, "git-history-segment-dashed": Boolean(segment().dashed) }}
            d={segmentPath(segment())}
            data-color={segment().color}
          />
        )}
      </Index>
      <Show when={props.row.hasHiddenParents}>
        <circle class="git-history-hidden-parent-ring" cx={x(props.row.lane)} cy={props.height / 2} r="7.3" />
      </Show>
      <circle class="git-history-node-halo" cx={x(props.row.lane)} cy={props.height / 2} r="5.3" />
      <circle
        class="git-history-node"
        cx={x(props.row.lane)}
        cy={props.height / 2}
        r="3.1"
        data-color={props.row.color}
      />
    </svg>
  );
}

function CommitDetails(props: {
  commit: GitCommit;
  loading: boolean;
  error?: string;
  files: GitCommitFile[];
  loaded: boolean;
  onCopy: (hash: string) => void;
  onRetry: (commit: GitCommit) => void;
  onCreateBranch: (commit?: GitCommit) => void;
  onOpenDiff: (commit: GitCommit, file: GitCommitFile) => void;
  onClose: () => void;
}) {
  return (
    <section
      class="git-history-details"
      aria-label={t("Commit details")}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
      }}
    >
      <div class="git-history-details-heading">
        <div class="git-history-details-title">
          <strong title={props.commit.subject}>{props.commit.subject}</strong>
          <span title={props.commit.authoredAt ?? props.commit.date}>
            {props.commit.shortHash} · {props.commit.author} · {relativeCommitAge(props.commit)}
          </span>
        </div>
        <div class="git-history-detail-actions">
          <button type="button" onClick={() => props.onCopy(props.commit.hash)} title={t("Copy full commit hash")}>
            <Icon name="copy" size={12} />
            <span>{t("Copy hash")}</span>
          </button>
          <button
            type="button"
            onClick={() => props.onCreateBranch(props.commit)}
            title={t("Create a branch from {shortHash}", { shortHash: props.commit.shortHash })}
          >
            <Icon name="plus" size={12} />
            <span>{t("Create branch")}</span>
          </button>
          <button type="button" onClick={props.onClose} title={t("Close")} aria-label={t("Close")}>
            <Icon name="close" size={11} />
          </button>
        </div>
      </div>
      <div class="git-history-files-heading">
        <span>{t("Changed files")}</span>
        <Show when={props.loaded && !props.loading}>
          <span>{props.files.length}</span>
        </Show>
      </div>
      <Show when={props.loading}>
        <div class="git-history-files-state">{t("Loading changed files…")}</div>
      </Show>
      <Show when={!props.loading && props.error}>
        <div class="git-history-files-state git-history-files-error">
          {t("Unable to load changed files: {error}", { error: props.error })}
          <button type="button" onClick={() => props.onRetry(props.commit)}>
            {t("Retry")}
          </button>
        </div>
      </Show>
      <Show when={!props.loading && !props.error && props.loaded && !props.files.length}>
        <div class="git-history-files-state">{t("No changed files")}</div>
      </Show>
      <Show when={!props.loading && !props.error && !props.loaded}>
        <div class="git-history-files-state">{t("Changed file list is unavailable")}</div>
      </Show>
      <Show when={!props.loading && !props.error && props.files.length}>
        <div class="git-history-files">
          <For each={props.files}>
            {(file) => (
              <button
                class="git-history-file"
                type="button"
                onClick={() => props.onOpenDiff(props.commit, file)}
                title={t("Open {path} from commit {shortHash}", { path: file.path, shortHash: props.commit.shortHash })}
              >
                <span class={`git-history-file-status git-history-file-status-${file.status.slice(0, 1)}`}>
                  {file.status}
                </span>
                <span>{file.path}</span>
                <Icon name="chevron-right" size={11} />
              </button>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

function HighlightedText(props: { value: string; query: string }) {
  const parts = createMemo(() => {
    const query = props.query.trim();
    if (!query) return [{ text: props.value, match: false }];
    const lowerValue = props.value.toLocaleLowerCase();
    const lowerQuery = query.toLocaleLowerCase();
    const result: Array<{ text: string; match: boolean }> = [];
    let offset = 0;
    while (offset < props.value.length) {
      const index = lowerValue.indexOf(lowerQuery, offset);
      if (index < 0) {
        result.push({ text: props.value.slice(offset), match: false });
        break;
      }
      if (index > offset) result.push({ text: props.value.slice(offset, index), match: false });
      result.push({ text: props.value.slice(index, index + query.length), match: true });
      offset = index + query.length;
    }
    return result;
  });
  return <For each={parts()}>{(part) => (part.match ? <mark>{part.text}</mark> : part.text)}</For>;
}
