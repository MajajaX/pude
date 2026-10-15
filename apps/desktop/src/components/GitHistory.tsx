import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "./Icons";
import { buildGitGraph } from "../lib/git-graph";
import { reconcileGitHistoryBranchFilter, type GitHistoryBranchFilter } from "../lib/git-history-filter";
import { GIT_HISTORY_ROW_HEIGHT, gitHistoryRenderWindow } from "../lib/git-history-virtualization";
import type { GitBranch, GitCommit, GitCommitFile } from "../types";
import "../styles/git-history.css";

type BranchFilter = GitHistoryBranchFilter;
type HistoryBranch = { value: BranchFilter; name: string; kind: "local" | "remote"; tipHash?: string; current: boolean };
type CommitTooltip = { commit: GitCommit; left: number; top: number; width: number; maxHeight: number };

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

const commitRowHeight = 44;
const ageFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

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
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  let copyMessageTimer: ReturnType<typeof setTimeout> | undefined;
  let tooltipCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressedFocusedTooltipHash: string | undefined;

  const commitByHash = createMemo(() => new Map(props.commits.map((commit) => [commit.hash, commit])));
  const headCommit = createMemo(() => {
    const exactHead = props.headOid ? commitByHash().get(props.headOid) : undefined;
    if (exactHead) return exactHead;
    return props.commits.find((commit) => commit.refs.some((reference) => reference === "HEAD" || reference.startsWith("HEAD -> ")));
  });
  const currentBranchName = () => props.currentBranch ?? props.branches.find((branch) => branch.current)?.name ?? "";
  const branchOptions = createMemo(() => historyBranchOptions(props.commits, props.branches, currentBranchName()));
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
    return props.commits.filter((commit) => reachable.has(commit.hash));
  };

  const visibleCommits = createMemo(() => {
    const selected = branchFilter();
    if (selected === "all") return props.commits;
    if (selected === "current-head") return commitsReachableFrom(headCommit()?.hash);
    const branch = branchOptions().find((option) => option.value === selected);
    const startHash = branch?.current ? headCommit()?.hash ?? branch.tipHash : branch?.tipHash;
    return commitsReachableFrom(startHash);
  });
  const graph = createMemo(() => buildGitGraph(visibleCommits()));
  const listTop = () => {
    const list = listElement();
    if (!scrollHost || !list) return 0;
    if (scrollHost === list) return 0;
    return list.getBoundingClientRect().top - scrollHost.getBoundingClientRect().top + scrollHost.scrollTop;
  };
  const renderWindow = createMemo(() => {
    const rows = graph().rows;
    const focusedIndex = focusedHash()
      ? rows.findIndex((row) => row.commit.hash === focusedHash())
      : -1;
    return gitHistoryRenderWindow(
      rows.length,
      Math.max(0, scrollTop() - listTop()),
      viewportHeight(),
      focusedIndex,
    );
  });
  const rowIndexes = createMemo(() => new Map(graph().rows.map((row, index) => [row.commit.hash, index])));
  const renderedRows = createMemo(() => {
    const rows = graph().rows;
    // Keep the graph row objects as For keys so scrolling doesn't recreate
    // buttons and steal keyboard focus from a row that remains mounted.
    return renderWindow().indexes.flatMap((index) => rows[index] ? [rows[index]] : []);
  });
  const historyContentHeight = () => graph().rows.length * GIT_HISTORY_ROW_HEIGHT + (props.historyHasMore ? 46 : 0);
  const railWidth = createMemo(() => {
    const laneCount = Math.max(1, graph().laneCount);
    return Math.max(props.fullMode ? 46 : 30, laneCount * 14 + 4);
  });
  const selectedCommit = createMemo(() => props.commits.find((commit) => commit.hash === selectedHash()));
  const filesFor = (commit: GitCommit) => Object.prototype.hasOwnProperty.call(props.commitFiles, commit.hash)
    ? props.commitFiles[commit.hash]
    : commit.files;
  const visibleHashSet = createMemo(() => new Set(visibleCommits().map((commit) => commit.hash)));
  const loadedHashSet = createMemo(() => new Set(props.commits.map((commit) => commit.hash)));
  const hasUnloadedParents = createMemo(() => props.commits.some((commit) => (commit.parents ?? []).some((parent) => !loadedHashSet().has(parent))));
  const hasUnknownParents = createMemo(() => props.commits.some((commit) => commit.parents === undefined));
  const hasFilteredParents = createMemo(() => visibleCommits().some((commit) => (commit.parents ?? []).some((parent) => loadedHashSet().has(parent) && !visibleHashSet().has(parent))));
  const searchMatches = createMemo(() => {
    const query = search().trim().toLocaleLowerCase();
    if (!query) return [];
    return visibleCommits().filter((commit) => [commit.subject, commit.body ?? "", commit.author, commit.date, commit.authoredAt ?? "", commit.hash, commit.refs.join(" ")]
      .some((value) => value.toLocaleLowerCase().includes(query)));
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
    if (hash && !visibleHashSet().has(hash)) setSelectedHash(undefined);
  });

  const closeTooltip = () => {
    clearTimeout(tooltipCloseTimer);
    tooltipCloseTimer = undefined;
    setTooltip(undefined);
  };
  const cancelTooltipClose = () => {
    clearTimeout(tooltipCloseTimer);
    tooltipCloseTimer = undefined;
  };
  const scheduleTooltipClose = () => {
    cancelTooltipClose();
    tooltipCloseTimer = setTimeout(() => {
      const activeTooltip = tooltip();
      const focusedRow = activeTooltip && rowElements.get(activeTooltip.commit.hash);
      const focused = focusedRow && focusedRow === document.activeElement && focusedRow.matches(":focus-visible") && suppressedFocusedTooltipHash !== activeTooltip.commit.hash;
      if (!focused) setTooltip(undefined);
    }, 180);
  };
  const updateViewport = () => {
    if (!scrollHost) return;
    setScrollTop(scrollHost.scrollTop);
    setViewportHeight(scrollHost.clientHeight);
  };
  createEffect(() => {
    // The history table is conditional, so the first mount can happen before
    // Git returns its initial page. Ref signals and content height both cause
    // this effect to attach or refresh the active scroll host after that page
    // becomes available.
    historyContentHeight();
    const table = tableElement();
    const list = listElement();
    const host = props.fullMode
      ? (table?.isConnected ? table : undefined)
      : (list?.isConnected ? list : undefined);
    if (!host) {
      scrollHost = undefined;
      return;
    }
    scrollHost = host;
    const handleScroll = () => {
      updateViewport();
      closeTooltip();
    };
    host.addEventListener("scroll", handleScroll, { passive: true });
    updateViewport();
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateViewport);
    resizeObserver?.observe(host);
    onCleanup(() => {
      host.removeEventListener("scroll", handleScroll);
      resizeObserver?.disconnect();
      if (scrollHost === host) scrollHost = undefined;
    });
  });
  onMount(() => {
    const closeOrRepositionOnScroll = (event: Event) => {
      const activeTooltip = document.getElementById(tooltipId);
      if (event.target instanceof Node && activeTooltip?.contains(event.target)) return;
      const focusedRow = [...rowElements.entries()].find(([hash, row]) => {
        if (row !== document.activeElement || !row.matches(":focus-visible") || suppressedFocusedTooltipHash === hash) return false;
        const bounds = row.getBoundingClientRect();
        const hostBounds = scrollHost?.getBoundingClientRect();
        return hostBounds && bounds.bottom > hostBounds.top && bounds.top < hostBounds.bottom;
      });
      if (focusedRow && suppressedFocusedTooltipHash !== focusedRow[0]) {
        const commit = commitByHash().get(focusedRow[0]);
        if (commit) { showTooltip(commit, focusedRow[1]); return; }
      }
      closeTooltip();
    };
    window.addEventListener("scroll", closeOrRepositionOnScroll, true);
    window.addEventListener("resize", closeTooltip);
    onCleanup(() => {
      window.removeEventListener("scroll", closeOrRepositionOnScroll, true);
      window.removeEventListener("resize", closeTooltip);
    });
  });
  onCleanup(() => { clearTimeout(copyMessageTimer); closeTooltip(); });

  const showTooltip = (commit: GitCommit, row: HTMLButtonElement) => {
    cancelTooltipClose();
    const bounds = row.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const tableBounds = row.closest<HTMLElement>(".git-history-table")?.getBoundingClientRect();
    const listBounds = row.closest<HTMLElement>(".git-history-list")?.getBoundingClientRect();
    const areaTop = Math.max(8, tableBounds?.top ?? 8, listBounds?.top ?? 8);
    const areaBottom = Math.min(viewportHeight - 8, tableBounds?.bottom ?? viewportHeight - 8, listBounds?.bottom ?? viewportHeight - 8);
    const width = Math.max(220, Math.min(360, viewportWidth - 16));
    const maxHeight = Math.max(64, Math.min(420, viewportHeight - 16, areaBottom - areaTop - 8));
    const left = Math.max(8, Math.min(bounds.right + 8, viewportWidth - width - 8));
    let top = bounds.bottom + 6;
    if (top + maxHeight > areaBottom - 4) top = bounds.top - maxHeight - 6;
    top = Math.max(areaTop + 4, Math.min(top, areaBottom - maxHeight - 4));
    setTooltip({ commit, left, top, width, maxHeight });
  };

  const ensureCommitFiles = (commit: GitCommit) => {
    if (Object.prototype.hasOwnProperty.call(props.commitFiles, commit.hash) || commit.files.length || props.isLoading(commit.hash) || props.commitLoadErrors[commit.hash]) return;
    props.onLoadFiles(commit);
  };

  const scrollToCommit = (hash: string) => {
    const index = graph().rows.findIndex((row) => row.commit.hash === hash);
    if (index < 0) return;
    if (scrollHost) {
      const rowTop = index * GIT_HISTORY_ROW_HEIGHT;
      const rowBottom = rowTop + GIT_HISTORY_ROW_HEIGHT;
      const viewportTop = scrollHost.scrollTop - listTop();
      let target = scrollHost.scrollTop;
      if (rowTop < viewportTop) target = listTop() + rowTop;
      else if (rowBottom > viewportTop + viewportHeight()) target = listTop() + rowBottom - viewportHeight();
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
    const index = visibleCommits().findIndex((item) => item.hash === commit.hash);
    const next = visibleCommits()[Math.max(0, Math.min(visibleCommits().length - 1, index + offset))];
    if (!next) return;
    scrollToCommit(next.hash);
  };

  const moveToHistoryBoundary = (boundary: "first" | "last") => {
    const commits = visibleCommits();
    const commit = boundary === "first" ? commits[0] : commits[commits.length - 1];
    if (commit) scrollToCommit(commit.hash);
  };

  const jumpToHead = () => {
    const head = headCommit();
    if (!head) {
      setCopyMessage("HEAD is not in the loaded history");
      clearTimeout(copyMessageTimer);
      copyMessageTimer = setTimeout(() => setCopyMessage(""), 2200);
      return;
    }
    if (!visibleHashSet().has(head.hash)) setBranchFilter("all");
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
      setCopyMessage("Hash copied");
    } catch {
      setCopyMessage("Clipboard is unavailable");
    }
    clearTimeout(copyMessageTimer);
    copyMessageTimer = setTimeout(() => setCopyMessage(""), 1800);
  };

  const setBranchChoice = (value: string) => setBranchFilter(value as BranchFilter);

  const referencesFor = (commit: GitCommit) => commitReferences(commit, props.branches);

  return (
    <section classList={{ "git-history": true, "git-history-full": Boolean(props.fullMode) }} aria-label="Git history" onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        searchInput?.focus();
        searchInput?.select();
      }
    }}>
      <div class="git-history-toolbar">
        <div class="git-history-tools">
          <label class="git-history-filter">
            <span class="git-history-sr-only">Filter commits by branch</span>
            <select value={branchFilter()} onChange={(event) => setBranchChoice(event.currentTarget.value)} aria-label="Filter commits by branch">
              <option value="all">All branches</option>
              <Show when={props.repositoryState === "detached"}><option value="current-head">Current HEAD</option></Show>
              <Show when={!branchOptions().length}><option value="all" disabled>No branch refs available</option></Show>
              <Show when={branchOptions().some((branch) => branch.kind === "local")}>
                <optgroup label="Local branches">
                  <For each={branchOptions().filter((branch) => branch.kind === "local")}>{(branch) => <option value={branch.value}>{branch.name}{branch.current ? " · HEAD" : ""}</option>}</For>
                </optgroup>
              </Show>
              <Show when={branchOptions().some((branch) => branch.kind === "remote")}>
                <optgroup label="Remote branches">
                  <For each={branchOptions().filter((branch) => branch.kind === "remote")}>{(branch) => <option value={branch.value}>{branch.name}</option>}</For>
                </optgroup>
              </Show>
            </select>
          </label>
        </div>
        <div class="git-history-tools git-history-tools-right">
          <label class="git-history-search">
            <Icon name="search" size={12} />
            <input ref={searchInput} autocorrect="off" autocapitalize="off" spellcheck={false} value={search()} onInput={(event) => setSearch(event.currentTarget.value)} onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); jumpToSearchMatch(event.shiftKey ? -1 : 1); }
              if (event.key === "Escape") { event.stopPropagation(); setSearch(""); searchInput?.blur(); }
            }} placeholder="Search history" aria-label="Search history; Enter jumps to a match" />
            <Show when={search().trim()}><span class="git-history-match-count">{searchMatches().length}</span></Show>
          </label>
          <div class="git-history-toolbar-actions">
            <button class="git-history-icon-button" type="button" title="Locate current HEAD" aria-label="Locate current HEAD" onClick={jumpToHead}><span class="git-history-head-icon">●</span></button>
            <button class="git-history-icon-button" type="button" title="Refresh history" aria-label="Refresh history" onClick={props.onRefresh}><Icon name="refresh" size={13} /></button>
            <Show when={props.onOpenHistory}><button class="git-history-icon-button git-history-expand" type="button" title="Open full history" aria-label="Open full history" onClick={props.onOpenHistory}><Icon name="external" size={13} /></button></Show>
          </div>
        </div>
      </div>

      <Show when={props.loading}><div class="git-history-loading" role="status">Refreshing history…</div></Show>
      <Show when={props.error}><div class="git-history-error" role="alert">{props.error}</div></Show>
      <Show when={hasUnloadedParents()}><div class="git-history-note" role="note">Some older parents are outside the loaded history; dashed edges or dotted nodes mark those boundaries.</div></Show>
      <Show when={hasUnknownParents()}><div class="git-history-note" role="note">Some commits have unavailable parent data; dotted nodes mark incomplete ancestry.</div></Show>
      <Show when={hasFilteredParents()}><div class="git-history-note" role="note">Dotted nodes mark commits with a parent hidden by the selected branch filter.</div></Show>
      <Show when={copyMessage()}><div class="git-history-feedback" role="status">{copyMessage()}</div></Show>
      <Show when={search().trim() && !searchMatches().length}><div class="git-history-search-empty" role="status">No commits match “{search().trim()}”. The history rows remain visible.</div></Show>

      <Show when={visibleCommits().length} fallback={<div class="git-history-empty">{props.loading ? "Loading commit history…" : props.commits.length ? "No history found for the selected branches" : "No commit history"}</div>}>
          <div class="git-history-table" ref={setTableElement} style={{ "--history-rail-width": `${railWidth()}px`, "--history-row-height": `${GIT_HISTORY_ROW_HEIGHT}px` }} onScroll={closeTooltip}>
          <Show when={props.fullMode}><div class="git-history-column-header"><span>GRAPH</span><span>MESSAGE</span><span>AUTHOR</span><span>DATE</span><span>HASH</span></div></Show>
          <div class="git-history-list" ref={setListElement} role="list" aria-label="Commits" onScroll={closeTooltip} onKeyDown={(event) => {
          if (event.key === "Escape") {
            const focusedRow = [...rowElements.entries()].find(([, row]) => row === document.activeElement);
            if (focusedRow) suppressedFocusedTooltipHash = focusedRow[0];
            closeTooltip();
            setSelectedHash(undefined);
          }
        }}>
          <div class="git-history-rows" style={{ position: "relative", height: `${historyContentHeight()}px` }}>
          <For each={renderedRows()}>{(row) => {
            const index = () => rowIndexes().get(row.commit.hash) ?? 0;
            const commit = row.commit;
            const rowRef = (element: HTMLButtonElement) => {
              rowElements.set(commit.hash, element);
              onCleanup(() => rowElements.delete(commit.hash));
            };
            const references = referencesFor(commit);
            const visibleReferenceCount = props.fullMode ? 4 : 2;
            return <div classList={{ "git-history-row-wrap": true, "git-history-row-selected": selectedHash() === commit.hash, "git-history-row-boundary": row.hasHiddenParents }} style={{ position: "absolute", top: `${index() * GIT_HISTORY_ROW_HEIGHT}px`, left: "0", right: "0" }} role="listitem">
              <button ref={rowRef} class="git-history-row" type="button" aria-current={selectedHash() === commit.hash ? "true" : undefined} aria-describedby={tooltip()?.commit.hash === commit.hash ? tooltipId : undefined} aria-label={`${commit.subject}, ${commit.author}, ${commit.date}, ${commit.shortHash}${row.hasHiddenParents ? ", history boundary" : ""}`} onMouseEnter={(event) => { cancelTooltipClose(); showTooltip(commit, event.currentTarget); }} onMouseLeave={(event) => { if (event.currentTarget.matches(":focus-visible") && suppressedFocusedTooltipHash !== commit.hash) showTooltip(commit, event.currentTarget); else scheduleTooltipClose(); }} onFocus={(event) => { setFocusedHash(commit.hash); suppressedFocusedTooltipHash = undefined; showTooltip(commit, event.currentTarget); }} onBlur={(event) => { if (focusedHash() === commit.hash) setFocusedHash(undefined); if (!event.currentTarget.matches(":hover") && !event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleTooltipClose(); }} onClick={() => { suppressedFocusedTooltipHash = commit.hash; selectCommit(commit); }} onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); moveSelection(commit, 1); }
                if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(commit, -1); }
                if (event.key === "Home") { event.preventDefault(); moveToHistoryBoundary("first"); }
                if (event.key === "End") { event.preventDefault(); moveToHistoryBoundary("last"); }
                if (event.key === "Escape") { event.preventDefault(); suppressedFocusedTooltipHash = commit.hash; closeTooltip(); setSelectedHash(undefined); }
              }}>
                <GitGraphRail row={row} laneCount={graph().laneCount} width={railWidth()} />
                <span class="git-history-columns">
                  <span class="git-history-message">
                    <span class="git-history-subject" title={commit.subject}><HighlightedText value={commit.subject} query={search()} /></span>
                    <span class="git-history-ref-list" aria-label={commit.refs.length ? `References: ${commit.refs.join(", ")}` : undefined}>
                      <For each={references}>{(reference, refIndex) => <Show when={refIndex() < visibleReferenceCount}><span class={`git-history-ref git-history-ref-${reference.kind}`} title={`${reference.kind}: ${reference.label}`}>{reference.label}</span></Show>}</For>
                      <Show when={references.length > visibleReferenceCount}><span class="git-history-ref-more" title={references.slice(visibleReferenceCount).map((reference) => reference.label).join(", ")}>+{references.length - visibleReferenceCount}</span></Show>
                    </span>
                    <Show when={!props.fullMode}><span class="git-history-meta" title={commit.authoredAt ?? commit.date}><HighlightedText value={`${commit.shortHash} · ${commit.author} · ${relativeCommitAge(commit)}`} query={search()} /></span></Show>
                  </span>
                  <Show when={props.fullMode}><span class="git-history-author" title={commit.author}><HighlightedText value={commit.author} query={search()} /></span><span class="git-history-date" title={commit.authoredAt ?? commit.date}><HighlightedText value={commit.date} query={search()} /></span><span class="git-history-hash" title={commit.hash}><HighlightedText value={commit.shortHash} query={search()} /></span></Show>
                </span>
              </button>
            </div>;
          }}</For>
          <Show when={props.historyHasMore}><div class="git-history-load-more" style={{ position: "absolute", top: `${graph().rows.length * GIT_HISTORY_ROW_HEIGHT}px`, left: "0", right: "0" }}><button type="button" disabled={props.loading || props.historyLoadingMore} onClick={() => { if (!props.loading && !props.historyLoadingMore) props.onLoadMoreHistory(); }}>{props.historyLoadingMore ? "Loading older commits…" : "Load older commits"}</button></div></Show>
          </div>
          </div>
        </div>
      </Show>

      <CommitDetails
        commit={selectedCommit()}
        loading={Boolean(selectedCommit() && props.isLoading(selectedCommit()!.hash))}
        error={selectedCommit() ? props.commitLoadErrors[selectedCommit()!.hash] : undefined}
        files={selectedCommit() ? filesFor(selectedCommit()!) : []}
        loaded={Boolean(selectedCommit() && (Object.prototype.hasOwnProperty.call(props.commitFiles, selectedCommit()!.hash) || selectedCommit()!.files.length))}
        onCopy={copyHash}
        onRetry={props.onLoadFiles}
        onCreateBranch={props.onCreateBranch}
        onOpenDiff={props.onOpenDiff}
        onClose={() => setSelectedHash(undefined)}
      />
      <Show when={tooltip()}>{(active) => <Portal mount={overlayRoot}>
        <CommitMetadataTooltip id={tooltipId} commit={active().commit} left={active().left} top={active().top} width={active().width} maxHeight={active().maxHeight} onMouseEnter={cancelTooltipClose} onMouseLeave={scheduleTooltipClose} />
      </Portal>}</Show>
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

function parseBranchReference(reference: string, localNames: ReadonlySet<string>): { kind: "local" | "remote"; name: string } | undefined {
  if (reference === "HEAD" || reference.startsWith("tag: ") || reference.startsWith("refs/tags/")) return undefined;
  if (reference.startsWith("refs/heads/")) return { kind: "local", name: reference.slice("refs/heads/".length) };
  if (reference.startsWith("refs/remotes/")) return { kind: "remote", name: reference.slice("refs/remotes/".length) };
  if (reference.startsWith("remotes/")) return { kind: "remote", name: reference.slice("remotes/".length) };
  if (localNames.has(reference)) return { kind: "local", name: reference };
  return { kind: "remote", name: reference };
}

function commitReferences(commit: GitCommit, branches: GitBranch[]): CommitReference[] {
  const localBranches = new Set(branches.map((branch) => branch.name));
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

function CommitMetadataTooltip(props: { id: string; commit: GitCommit; left: number; top: number; width: number; maxHeight: number; onMouseEnter: () => void; onMouseLeave: () => void }) {
  const parents = () => props.commit.parents === undefined
    ? "Parent data unavailable"
    : props.commit.parents.length ? props.commit.parents.join(", ") : "Root commit";
  return <div
    class="git-history-tooltip"
    id={props.id}
    role="tooltip"
    style={{ left: `${props.left}px`, top: `${props.top}px`, width: `${props.width}px`, "max-height": `${props.maxHeight}px` }}
    onMouseEnter={props.onMouseEnter}
    onMouseLeave={props.onMouseLeave}
  >
    <strong class="git-history-tooltip-subject">{props.commit.subject}</strong>
    <Show when={props.commit.body}><p class="git-history-tooltip-body">{props.commit.body}</p></Show>
    <dl class="git-history-tooltip-fields">
      <dt>Author</dt><dd>{props.commit.author}</dd>
      <dt>Date</dt><dd>{props.commit.authoredAt ?? props.commit.date}</dd>
      <dt>Hash</dt><dd><code>{props.commit.hash}</code></dd>
      <dt>Parents</dt><dd>{parents()}</dd>
      <dt>Refs</dt><dd>{props.commit.refs.length ? props.commit.refs.join(", ") : "None"}</dd>
    </dl>
  </div>;
}

function relativeCommitAge(commit: GitCommit): string {
  const timestamp = Date.parse(commit.authoredAt ?? commit.date);
  if (!Number.isFinite(timestamp)) return commit.date;
  const elapsedDays = (timestamp - Date.now()) / 86_400_000;
  const elapsedHours = elapsedDays * 24;
  const elapsedMinutes = elapsedHours * 60;
  if (Math.abs(elapsedMinutes) < 60) return ageFormatter.format(Math.round(elapsedMinutes), "minute");
  if (Math.abs(elapsedHours) < 24) return ageFormatter.format(Math.round(elapsedHours), "hour");
  if (Math.abs(elapsedDays) < 45) return ageFormatter.format(Math.round(elapsedDays), "day");
  const elapsedMonths = elapsedDays / 30.44;
  if (Math.abs(elapsedMonths) < 18) return ageFormatter.format(Math.round(elapsedMonths), "month");
  return ageFormatter.format(Math.round(elapsedDays / 365.25), "year");
}

function GitGraphRail(props: { row: ReturnType<typeof buildGitGraph>["rows"][number]; laneCount: number; width: number }) {
  const laneTotal = () => Math.max(1, props.laneCount);
  const x = (lane: number) => 7 + (laneTotal() <= 1 ? 0 : lane * ((props.width - 14) / (laneTotal() - 1)));
  const y = (fraction: number) => fraction * commitRowHeight;
  const segmentPath = (segment: (typeof props.row.segments)[number]) => {
    const fromX = x(segment.fromLane);
    const toX = x(segment.toLane);
    const fromY = y(segment.fromY);
    const toY = y(segment.toY);
    if (segment.fromLane === segment.toLane) return `M ${fromX} ${fromY} L ${toX} ${toY}`;
    const middleY = (fromY + toY) / 2;
    return `M ${fromX} ${fromY} C ${fromX} ${middleY} ${toX} ${middleY} ${toX} ${toY}`;
  };
  return <svg class="git-history-graph" width={props.width} height={commitRowHeight} viewBox={`0 0 ${props.width} ${commitRowHeight}`} aria-hidden="true">
    <For each={props.row.segments}>{(segment) => <path classList={{ "git-history-segment": true, "git-history-segment-dashed": Boolean(segment.dashed) }} d={segmentPath(segment)} data-color={segment.color} />}</For>
    <Show when={props.row.hasHiddenParents}><circle class="git-history-hidden-parent-ring" cx={x(props.row.lane)} cy={commitRowHeight / 2} r="7.3" /></Show>
    <circle class="git-history-node-halo" cx={x(props.row.lane)} cy={commitRowHeight / 2} r="5.3" />
    <circle class="git-history-node" cx={x(props.row.lane)} cy={commitRowHeight / 2} r="3.1" data-color={props.row.color} />
  </svg>;
}

function CommitDetails(props: {
  commit?: GitCommit;
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
  return <section class="git-history-details" aria-label="Commit details" onKeyDown={(event) => {
    if (event.key === "Escape") props.onClose();
  }}>
    <Show when={props.commit} fallback={<div class="git-history-details-empty">Select a commit to view changed files</div>}>
      {(commit) => <>
        <div class="git-history-details-heading">
          <div class="git-history-details-title"><strong>Changed files</strong><Show when={props.loaded && !props.loading}><span>{props.files.length} in {commit().shortHash}</span></Show></div>
          <div class="git-history-detail-actions">
            <button type="button" onClick={() => props.onCopy(commit().hash)} title="Copy full commit hash"><Icon name="copy" size={12} /><span>Copy hash</span></button>
            <button type="button" onClick={() => props.onCreateBranch(commit())} title={`Create a branch from ${commit().shortHash}`}><Icon name="plus" size={12} /><span>Create branch</span></button>
          </div>
        </div>
        <Show when={props.loading}><div class="git-history-files-state">Loading changed files…</div></Show>
        <Show when={!props.loading && props.error}><div class="git-history-files-state git-history-files-error">Unable to load changed files: {props.error}<button type="button" onClick={() => props.onRetry(commit())}>Retry</button></div></Show>
        <Show when={!props.loading && !props.error && props.loaded && !props.files.length}><div class="git-history-files-state">No changed files</div></Show>
        <Show when={!props.loading && !props.error && !props.loaded}><div class="git-history-files-state">Changed file list is unavailable</div></Show>
        <Show when={!props.loading && !props.error && props.files.length}>
          <div class="git-history-files">
            <For each={props.files}>{(file) => <button class="git-history-file" type="button" onClick={() => props.onOpenDiff(commit(), file)} title={`Open ${file.path} from commit ${commit().shortHash}`}>
              <span class={`git-history-file-status git-history-file-status-${file.status.slice(0, 1)}`}>{file.status}</span><span>{file.path}</span><Icon name="chevron-right" size={11} />
            </button>}</For>
          </div>
        </Show>
      </>}
    </Show>
  </section>;
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
      if (index < 0) { result.push({ text: props.value.slice(offset), match: false }); break; }
      if (index > offset) result.push({ text: props.value.slice(offset, index), match: false });
      result.push({ text: props.value.slice(index, index + query.length), match: true });
      offset = index + query.length;
    }
    return result;
  });
  return <For each={parts()}>{(part) => part.match ? <mark>{part.text}</mark> : part.text}</For>;
}
