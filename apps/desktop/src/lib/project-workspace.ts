import type { DirectoryEntry, DiffResult, EditorTab, GitStatusResult, GitBranch, ReadFileResult } from "../types";
import type { PersistedTab, RecoverySnapshot } from "./session-storage-schema";
import { restorePersistedTab, type RestoreTabReadFailure } from "./session-restore-documents";
import { markRestoreTabStarted, shouldMergeRestoredTab } from "./restore-state";
import { limitIo } from "./io-limiter";
import type { EditorDocumentHandle, SearchRequest } from "../components/EditorPane";
import type { RestoreIntent } from "./restore-state";
import { createSessionMetadata, retainSessionTabs, type SessionMetadata, type ProjectSessionMetadata } from "./session-storage-schema";
export { VersionedFileReader } from "./versioned-file-reader";
export { createWindowSessionMetadata, compactRecoverySnapshot, recoverySnapshotSizeBytes } from "./session-storage-schema";

export type ProjectWorkspaceState = {
  id: string;
  workspace: string;
  root: DirectoryEntry;
  tabIds: string[];
  activeTabId?: string;
  viewMode: "editor" | "diff" | "history";
  historyTabOpen: boolean;
  diffReturnToHistory: boolean;
  diff?: DiffResult;
  git: GitStatusResult;
  gitBranches: GitBranch[];
  sidebarView: "explorer" | "git";
  search: SearchRequest;
  searchOpen: boolean;
  replaceOpen: boolean;
  markdownPreviewEnabled?: boolean;
  gitIgnoredExpanded?: boolean;
  lastClosedTab?: EditorTab;
  terminalOpen: boolean;
  terminalInitialized: boolean;
  restoreMetadata?: SessionMetadata;
  restoreIntent?: RestoreIntent;
  conflicts: EditorTab[];
};

export function createProject(id: string, workspace: string, root: DirectoryEntry): ProjectWorkspaceState {
  return {
    id, workspace, root, tabIds: [], viewMode: "editor", historyTabOpen: false, diffReturnToHistory: false,
    git: { repositoryRoot: "", branch: null, repositoryState: "unknown", headOid: null, files: [], commits: [], error: null },
    gitBranches: [], sidebarView: "explorer",
    search: { query: "", replace: "", caseSensitive: false, regexp: false, wholeWord: false, action: null, actionId: 0 },
    searchOpen: false, replaceOpen: false, terminalOpen: false, terminalInitialized: false, conflicts: [],
  };
}

export function pendingRestoreTabs(project: Pick<ProjectWorkspaceState, "restoreMetadata" | "restoreIntent">, pathKey: (path: string) => string): PersistedTab[] {
  const intent = project.restoreIntent;
  if (!intent || !project.restoreMetadata) return [];
  return project.restoreMetadata.tabs.filter((tab) => intent.pendingTabIds.has(tab.id)
    && !intent.cancelledTabIds.has(tab.id) && !intent.openedPaths.has(pathKey(tab.path)));
}

export function projectHasDirtyTabs(project: ProjectWorkspaceState, getTab: (id: string) => EditorTab | undefined, pathKey: (path: string) => string): boolean {
  return project.tabIds.some((id) => getTab(id)?.dirty) || pendingRestoreTabs(project, pathKey).some((tab) => tab.dirty && !getTab(tab.id));
}

export function projectSession(project: ProjectWorkspaceState, getTab: (id: string) => EditorTab | undefined, pathKey: (path: string) => string,
  expandedPaths?: (root: DirectoryEntry) => string[]): ProjectSessionMetadata {
  const session = createSessionMetadata(project.workspace, project.activeTabId,
    project.tabIds.map(getTab).filter((tab): tab is EditorTab => Boolean(tab)), project.root, expandedPaths?.(project.root));
  const ids = new Set(session.tabs.map((tab) => tab.id));
  const pending = pendingRestoreTabs(project, pathKey).filter((tab) => !ids.has(tab.id));
  const pendingById = new Map(pending.map((tab) => [tab.id, tab]));
  let loadedIndex = 0;
  const ordered = pending.length ? project.restoreMetadata!.tabs.flatMap((tab) => {
    const retained = pendingById.get(tab.id);
    if (retained) return [retained];
    return ids.has(tab.id) ? [session.tabs[loadedIndex++]] : [];
  }) : session.tabs;
  return { id: project.id, workspace: project.workspace, activeTabId: session.activeTabId ?? project.restoreMetadata?.activeTabId,
    tabs: retainSessionTabs(pending.length ? [...ordered, ...session.tabs.slice(loadedIndex)] : ordered),
    expandedPaths: project.root.loaded || !project.restoreMetadata ? session.expandedPaths : project.restoreMetadata.expandedPaths };
}

export async function restoreProjectDocuments(options: {
  session?: SessionMetadata;
  intent?: RestoreIntent;
  scope: string;
  recoveries?: Readonly<Record<string, RecoverySnapshot>>;
  dirtyOnly?: boolean;
  isCurrent: () => boolean;
  readDocument: (path: string) => Promise<ReadFileResult>;
  normalizeReadFile: (file: ReadFileResult) => ReadFileResult;
  createImageTab: (path: string, size?: number) => EditorTab;
  getTabs: () => EditorTab[];
  getIntent: () => RestoreIntent | undefined;
  onTabs: (tabs: EditorTab[]) => void;
  onIntent: (intent: RestoreIntent) => void;
  onConflict: (tab: EditorTab) => void;
  onFailure: (failure: RestoreTabReadFailure) => void;
}): Promise<boolean> {
  const { session, intent } = options;
  if (!session || !intent?.pendingTabIds.size) return true;
  const ids = new Set(options.getTabs().map((tab) => tab.id));
  const pending = session.tabs.filter((tab) => (!options.dirtyOnly || tab.dirty)
    && intent.pendingTabIds.has(tab.id) && shouldMergeRestoredTab(intent, tab, ids));
  const ordered = [...pending.filter((tab) => tab.id === session.activeTabId), ...pending.filter((tab) => tab.id !== session.activeTabId)];
  const records = await Promise.all(ordered.map((tab) => limitIo(() => restorePersistedTab(tab, undefined, options.scope, options.recoveries, {
    readDocument: options.readDocument, normalizeReadFile: options.normalizeReadFile, createImageTab: options.createImageTab,
    isCurrent: options.isCurrent,
  }))));
  if (!options.isCurrent()) return false;
  let complete = true;
  const restored: EditorTab[] = [];
  let latestIntent = options.getIntent();
  const current = options.getTabs();
  const currentIds = new Set(current.map((tab) => tab.id));
  for (const record of records) {
    if (!record) { complete = false; continue; }
    if ("status" in record) { options.onFailure(record); complete = false; continue; }
    if (!latestIntent || !shouldMergeRestoredTab(latestIntent, record.tab, currentIds)) continue;
    latestIntent = markRestoreTabStarted(latestIntent, record.tab.id);
    restored.push({ ...record.tab, orphaned: record.orphaned });
    if (record.diskChangedSinceRecovery) options.onConflict(record.tab);
  }
  if (latestIntent) options.onIntent(latestIntent);
  const byId = new Map([...current, ...restored].map((tab) => [tab.id, tab]));
  const metadataIds = new Set(session.tabs.map((tab) => tab.id));
  options.onTabs([...session.tabs.flatMap((tab) => byId.get(tab.id) ? [byId.get(tab.id)!] : []), ...current.filter((tab) => !metadataIds.has(tab.id))]);
  return complete;
}

export function captureDirtyProjectTabs(tabs: readonly EditorTab[], getHandle: (id: string) => EditorDocumentHandle | undefined): EditorTab[] {
  return tabs.filter((tab) => tab.dirty).map((tab) => {
    const snapshot = getHandle(tab.id)?.getSnapshot();
    return { ...tab, content: snapshot?.content ?? getHandle(tab.id)?.getText() ?? tab.content,
      lineEndings: snapshot?.lineEndings ?? tab.lineEndings, lineEnding: snapshot?.lineEnding ?? tab.lineEnding,
      bom: snapshot?.bom ?? tab.bom, savedLineEndings: snapshot?.savedLineEndings ?? tab.savedLineEndings, savedBom: snapshot?.savedBom ?? tab.savedBom };
  });
}

export function projectCacheBytes(tabs: readonly EditorTab[], projects: readonly ProjectWorkspaceState[]): number {
  const documents = new Map(tabs.map((tab) => [tab.id, tab]));
  for (const project of projects) {
    const closed = project.lastClosedTab;
    if (closed && !documents.has(closed.id)) documents.set(closed.id, closed);
  }
  return [...documents.values()].reduce((bytes, tab) => bytes + 2 * (tab.content.length
    + (tab.savedContent === tab.content ? 0 : tab.savedContent.length)
    + (tab.lineEndings?.length ?? 0)
    + (tab.savedLineEndings === tab.lineEndings ? 0 : tab.savedLineEndings?.length ?? 0))
    + (tab.selectionFallback ? 64 + tab.selectionFallback.selection.ranges.length * 32 : 0), 0);
}
