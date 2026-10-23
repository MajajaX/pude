import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { Icon, LanguageIcon, languageIconForPath } from "./Icons";
import type { DirectoryEntry, GitFileStatus } from "../types";
import { treeKeyboardAction, virtualTreeWindow, VisibleTreeModel, type IndexedVisibleTreeRow } from "../lib/tree-virtualization";
import { joinWirePath, pathComparisonKey, runtimePathOptions } from "../lib/path-identity";
import { groupIgnoredEntries, type ExplorerEntry } from "../lib/explorer-ignored";
import { isWorkspaceRootEntry } from "../lib/workspace-folders";
import { isImeComposing } from "../lib/keyboard-input";
import "../styles/explorer-virtualization.css";
import { t, translateMessage } from "../lib/i18n";

const TREE_ROW_HEIGHT = 30;
const TREE_OVERSCAN = 8;

type ExplorerProps = {
  root: DirectoryEntry;
  activePath?: string;
  repositoryRoot?: string;
  gitFiles: GitFileStatus[];
  hideDotFiles: boolean;
  ignoredPaths?: ReadonlySet<string>;
  groupIgnored?: boolean;
  ignoredExpanded?: boolean;
  onToggleIgnored?: () => void;
  onToggle: (entry: ExplorerEntry) => void;
  onRetry?: (entry: DirectoryEntry) => void;
  onOpen: (entry: ExplorerEntry) => void;
  onContextMenu: (entry: DirectoryEntry, x: number, y: number) => void;
};

type StableTreeRow = {
  key: string;
  readonly entry: ExplorerEntry;
  readonly depth: number;
  readonly isRoot: boolean;
  readonly siblingIndex: number;
  readonly siblingCount: number;
  readonly index: number;
  update: (row: IndexedVisibleTreeRow<ExplorerEntry>) => void;
};

type StableTreeRowState = {
  entry: ExplorerEntry;
  depth: number;
  isRoot: boolean;
  siblingIndex: number;
  siblingCount: number;
  index: number;
};

function createStableTreeRow(row: IndexedVisibleTreeRow<ExplorerEntry>): StableTreeRow {
  const [state, setState] = createSignal<StableTreeRowState>(toStableTreeRowState(row));
  return {
    key: row.pathKey,
    get entry() { return state().entry; },
    get depth() { return state().depth; },
    get isRoot() { return state().isRoot; },
    get siblingIndex() { return state().siblingIndex; },
    get siblingCount() { return state().siblingCount; },
    get index() { return state().index; },
    update: (next) => setState(toStableTreeRowState(next)),
  };
}

function toStableTreeRowState(row: IndexedVisibleTreeRow<ExplorerEntry>): StableTreeRowState {
  return {
    entry: row.entry,
    depth: row.depth,
    isRoot: row.isRoot,
    siblingIndex: row.siblingIndex,
    siblingCount: row.siblingCount,
    index: row.index,
  };
}

export function Explorer(props: ExplorerProps) {
  const treeId = createUniqueId();
  const rowId = (index: number) => `${treeId}-row-${index}`;
  let treeHost!: HTMLDivElement;
  let scrollHost: HTMLElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [focusedKey, setFocusedKey] = createSignal<string>();
  const pathOptions = runtimePathOptions();
  const pathKey = (path: string) => pathComparisonKey(path, pathOptions);
  const isIgnored = (path: string) => props.ignoredPaths?.has(pathKey(path)) ?? false;
  const displayRoot = createMemo(() => {
    if (props.groupIgnored === false) return props.root;
    const group = (entry: DirectoryEntry) => groupIgnoredEntries(entry, isIgnored, props.ignoredExpanded ?? false, props.hideDotFiles);
    // Each folder of a multi-folder workspace groups its own ignored entries.
    return isWorkspaceRootEntry(props.root) ? { ...props.root, children: props.root.children?.map(group) } : group(props.root);
  });
  const treeModel = new VisibleTreeModel<ExplorerEntry>(pathOptions);
  treeModel.update(displayRoot(), props.hideDotFiles);
  const stableRowCache = new Map<string, StableTreeRow>();

  for (const row of treeModel.lastChange.changedRows) stableRowCache.set(row.pathKey, createStableTreeRow(row));
  const [treeVersion, setTreeVersion] = createSignal(treeModel.version);

  const statusByPath = createMemo(() => {
    const rootPath = props.repositoryRoot || props.root.path;
    const map = new Map<string, GitFileStatus>();
    for (const file of props.gitFiles) {
      map.set(pathKey(file.path), file);
      map.set(pathKey(joinWirePath(rootPath, file.path, pathOptions)), file);
    }
    return map;
  });
  const statusForKey = (key: string) => statusByPath().get(key);

  const rows = () => {
    treeVersion();
    return treeModel.rows;
  };
  const showRecentEmpty = createMemo(() => props.root.path === "pude://recent-projects" && !props.root.children?.length);
  const activeKey = createMemo(() => props.activePath ? pathKey(props.activePath) : undefined);
  const activeIndex = createMemo(() => {
    treeVersion();
    const key = activeKey();
    return key ? treeModel.indexOfKey(key) : -1;
  });
  const focusedIndex = createMemo(() => {
    treeVersion();
    const key = focusedKey();
    return key ? treeModel.indexOfKey(key) : -1;
  });
  const tabStopIndex = createMemo(() => {
    const currentRows = rows();
    const focused = focusedIndex();
    if (focused >= 0) return focused;
    const active = activeIndex();
    if (active >= 0) return active;
    return currentRows.length ? 0 : -1;
  });
  const window = createMemo(() => virtualTreeWindow(rows().length + (showRecentEmpty() ? 1 : 0), scrollTop(), viewportHeight(), TREE_ROW_HEIGHT, TREE_OVERSCAN));
  const renderedRows = createMemo(() => {
    const currentRows = rows();
    const currentWindow = window();
    const indexes = new Set<number>();
    for (let index = currentWindow.start; index < Math.min(currentRows.length, currentWindow.end); index += 1) indexes.add(index);
    for (const index of [activeIndex(), focusedIndex(), tabStopIndex()]) if (index >= 0) indexes.add(index);
    return [...indexes].sort((left, right) => left - right)
      .map((index) => stableRowCache.get(currentRows[index]?.pathKey ?? ""))
      .filter((row): row is StableTreeRow => Boolean(row));
  });

  const ensureIndexVisible = (index: number) => {
    if (index < 0 || !scrollHost) return;
    const top = scrollHost.scrollTop;
    const height = viewportHeight();
    const rowTop = index * TREE_ROW_HEIGHT;
    const rowBottom = rowTop + TREE_ROW_HEIGHT;
    let nextTop = top;
    if (rowTop < top) nextTop = rowTop;
    else if (rowBottom > top + height) nextTop = rowBottom - height;
    const maxTop = Math.max(0, window().maxScrollTop);
    nextTop = Math.min(Math.max(0, nextTop), maxTop);
    if (nextTop === top) return;
    scrollHost.scrollTop = nextTop;
    setScrollTop(nextTop);
  };

  const updateViewport = () => {
    if (!scrollHost) return;
    const style = getComputedStyle(scrollHost);
    setViewportHeight(Math.max(0, scrollHost.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)));
    setScrollTop(scrollHost.scrollTop);
  };

  const toggleEntry = (entry: ExplorerEntry) => {
    if (entry.gitIgnoredGroup) {
      setFocusedKey(pathKey(entry.path));
      props.onToggleIgnored?.();
    } else props.onToggle(entry);
  };
  const openEntry = (entry: ExplorerEntry) => {
    if (entry.gitIgnoredGroup) toggleEntry(entry);
    else props.onOpen(entry);
  };

  const handleTreeKeyDown = (event: KeyboardEvent) => {
    if (isImeComposing(event) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "treeitem") return;
    const currentRows = rows();
    const index = focusedIndex() >= 0 ? focusedIndex() : tabStopIndex();
    const action = treeKeyboardAction(currentRows, index, event.key);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.kind === "focus") {
      const next = currentRows[action.index];
      setFocusedKey(next.pathKey);
      ensureIndexVisible(action.index);
      queueMicrotask(() => document.getElementById(rowId(action.index))?.focus({ preventScroll: true }));
    } else if (action.kind === "toggle" && !currentRows[index].entry.recentProject) {
      toggleEntry(currentRows[index].entry);
    } else {
      openEntry(currentRows[index].entry);
    }
  };

  onMount(() => {
    scrollHost = treeHost.parentElement ?? undefined;
    if (!scrollHost) return;
    const handleScroll = () => setScrollTop(scrollHost?.scrollTop ?? 0);
    scrollHost.addEventListener("scroll", handleScroll, { passive: true });
    updateViewport();
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateViewport);
    resizeObserver?.observe(scrollHost);
    onCleanup(() => {
      scrollHost?.removeEventListener("scroll", handleScroll);
      resizeObserver?.disconnect();
    });
  });

  onCleanup(() => stableRowCache.clear());

  createEffect(() => {
    const root = displayRoot();
    const hideDotFiles = props.hideDotFiles;
    if (!treeModel.update(root, hideDotFiles)) return;
    const change = treeModel.lastChange;
    for (const key of change.removedPathKeys) {
      if (treeModel.indexOfKey(key) < 0) stableRowCache.delete(key);
    }
    for (const row of change.changedRows) {
      const stable = stableRowCache.get(row.pathKey);
      if (stable) stable.update(row);
      else stableRowCache.set(row.pathKey, createStableTreeRow(row));
    }
    const focused = focusedKey();
    const hadTreeFocus = typeof document !== "undefined" && treeHost?.contains(document.activeElement);
    if (focused && treeModel.indexOfKey(focused) < 0) {
      const group = treeModel.rows.find((row) => row.entry.gitIgnoredGroup);
      setFocusedKey(group?.pathKey ?? treeModel.rows[0]?.pathKey);
      if (hadTreeFocus) queueMicrotask(() => document.getElementById(rowId(focusedIndex()))?.focus({ preventScroll: true }));
    }
    setTreeVersion(change.version);
  });

  createEffect(() => {
    rows();
    viewportHeight();
    activeIndex();
    focusedIndex();
    queueMicrotask(() => ensureIndexVisible(focusedIndex() >= 0 ? focusedIndex() : activeIndex()));
  });

  createEffect(() => {
    const currentWindow = window();
    if (!scrollHost || scrollHost.scrollTop === currentWindow.scrollTop) return;
    scrollHost.scrollTop = currentWindow.scrollTop;
    setScrollTop(currentWindow.scrollTop);
  });

  return (
    <div class="explorer-tree" ref={treeHost} role="tree" aria-label={t("Files")} onKeyDown={handleTreeKeyDown} style={{ position: "relative", height: `${window().totalHeight}px` }}>
      <For each={renderedRows()}>{(row) => (
        <TreeRow
          row={row}
          id={rowId(row.index)}
          tabStop={tabStopIndex() === row.index}
          activeKey={activeKey()}
          statusForKey={statusForKey}
          hasRepository={Boolean(props.repositoryRoot)}
          onFocus={(key) => {
            setFocusedKey(key);
            ensureIndexVisible(treeModel.indexOfKey(key));
          }}
          ignored={isIgnored(row.entry.path)}
          onToggle={toggleEntry}
          onRetry={props.onRetry}
          onOpen={openEntry}
          onContextMenu={props.onContextMenu}
        />
      )}</For>
      <Show when={showRecentEmpty()}>
        <div class="recent-empty" style={{ position: "absolute", top: `${rows().length * TREE_ROW_HEIGHT}px`, left: "0", right: "0" }}>{t("No recent projects")}</div>
      </Show>
    </div>
  );
}

function TreeRow(props: {
  row: StableTreeRow;
  id: string;
  tabStop: boolean;
  activeKey?: string;
  statusForKey: (key: string) => GitFileStatus | undefined;
  hasRepository: boolean;
  ignored: boolean;
  onFocus: (key: string) => void;
  onToggle: (entry: ExplorerEntry) => void;
  onRetry?: (entry: DirectoryEntry) => void;
  onOpen: (entry: ExplorerEntry) => void;
  onContextMenu: ExplorerProps["onContextMenu"];
}) {
  const entry = () => props.row.entry;
  const status = createMemo(() => !props.ignored && entry().kind === "file" ? props.statusForKey(props.row.key) : undefined);
  const isUntracked = () => status()?.indexStatus === "?" || status()?.worktreeStatus === "?";
  const statusText = createMemo(() => {
    const current = status();
    return current ? current.indexStatus ?? current.worktreeStatus ?? "" : "";
  });
  const partialError = () => entry().partialError;
  const scanIssue = () => {
    const error = partialError();
    if (error) return { label: t("partial"), message: error.message ? translateMessage(error.message) : t("Some directory entries could not be read.") };
    // A collapsed stale directory relists itself when expanded, so only an open one needs attention.
    if (entry().stale && entry().expanded) return { label: t("stale"), message: t("Directory changed; refresh the scan.") };
    return undefined;
  };
  const listingLimitIssue = () => {
    const current = entry();
    if (current.kind !== "directory" || !current.incomplete) return undefined;
    if (current.listingStopReason === "entryLimit") {
      return {
        label: t("entry cap"),
        message: t("Directory listing reached the entry cap. Showing the encountered subset in sorted order; these are not guaranteed to be the globally first N entries, and this listing has no continuation page."),
      };
    }
    if (current.listingStopReason === "byteLimit") {
      return {
        label: t("byte cap"),
        message: t("Directory listing reached the byte cap. Showing the encountered subset in sorted order; these are not guaranteed to be the globally first N entries, and this listing has no continuation page."),
      };
    }
    // A cancelled scan is discarded by the caller and must not be described as a cap.
    return undefined;
  };
  const accessibleRowLabel = () => {
    const labels = [entry().name];
    if (scanIssue()) labels.push(t("directory scan needs refresh"));
    const limit = listingLimitIssue();
    if (limit) labels.push(limit.message);
    return labels.join("; ");
  };
  const retryScan = () => {
    if (props.onRetry) props.onRetry(entry());
    else props.onToggle(entry());
  };

  return (
    <div
      id={props.id}
      tabIndex={props.tabStop ? 0 : -1}
      classList={{
        "tree-row": true,
        "tree-row-active": props.activeKey === props.row.key,
        "tree-row-root": props.row.isRoot,
        "tree-row-tracked": entry().kind === "file" && props.hasRepository && !isUntracked(),
        "tree-row-ignored": props.ignored,
        "tree-row-ignored-group": Boolean(entry().gitIgnoredGroup),
        "tree-row-directory": entry().kind === "directory" && !entry().gitIgnoredGroup,
      }}
      style={{ position: "absolute", top: `${props.row.index * TREE_ROW_HEIGHT}px`, left: "0", right: "0", "padding-left": `${10 + props.row.depth * 16}px` }}
      role="treeitem"
      aria-level={props.row.depth + 1}
      aria-posinset={props.row.siblingIndex + 1}
      aria-setsize={props.row.siblingCount}
      aria-expanded={entry().kind === "directory" ? Boolean(entry().expanded) : undefined}
      aria-selected={props.activeKey === props.row.key}
      aria-label={accessibleRowLabel()}
      onFocus={() => props.onFocus(props.row.key)}
      onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.focus({ preventScroll: true }); }}
      onDblClick={() => props.onOpen(entry())}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!entry().recentProject && !entry().gitIgnoredGroup) props.onContextMenu(entry(), event.clientX, event.clientY);
      }}
    >
      <button
        tabIndex={-1}
        class="tree-chevron"
        aria-label={entry().recentProject ? t("Open recent project") : entry().kind === "directory" ? (entry().expanded ? t("Collapse") : t("Expand")) : t("Open")}
        onClick={(event) => {
          event.currentTarget.parentElement?.focus({ preventScroll: true });
          entry().recentProject ? props.onOpen(entry()) : entry().kind === "directory" ? props.onToggle(entry()) : props.onOpen(entry());
        }}
      >
        <Show when={entry().kind === "directory"} fallback={<span class="chevron-spacer" />}>
          <Icon name={entry().expanded ? "chevron-down" : "chevron-right"} size={13} />
        </Show>
      </button>
      <span class="tree-kind">
        <Show when={entry().gitIgnoredGroup} fallback={
          <Show when={entry().kind === "file" && languageIconForPath(entry().path)} fallback={<Icon name={entry().kind === "directory" ? (entry().expanded ? "folder-open" : "folder") : "file-code"} size={15} />}>
            {(language) => <LanguageIcon name={language()} size={15} />}
          </Show>
        }>
          <Icon name="git" size={13} />
        </Show>
      </span>
      <button class="tree-label" tabIndex={-1} onClick={(event) => { event.currentTarget.parentElement?.focus({ preventScroll: true }); props.onOpen(entry()); }}>{entry().name}</button>
      <Show when={entry().gitIgnoredGroup}><span class="tree-group-count">{entry().gitIgnoredCount}</span></Show>
      <Show when={statusText()}>
        <span class={`git-badge git-badge-${statusText()}`} title={statusText() === "?" ? t("Untracked file: Git is not tracking this file yet") : t("Git {statusText}", { statusText: statusText() })} aria-label={statusText() === "?" ? t("Untracked file") : t("Git {statusText}", { statusText: statusText() })}>{statusText()}</span>
      </Show>
      <Show when={listingLimitIssue()}>
        {(issue) => <span class="tree-scan-warning" title={issue().message} aria-hidden="true">{issue().label}</span>}
      </Show>
      <Show when={scanIssue()}>
        {(issue) => <>
          <span class="tree-scan-warning" title={issue().message}>{issue().label}</span>
          <button class="tree-retry" type="button" onClick={(event) => { event.stopPropagation(); retryScan(); }} aria-label={t("Retry scan for {name}", { name: entry().name })} title={t("Retry directory scan")}>↻</button>
        </>}
      </Show>
    </div>
  );
}
