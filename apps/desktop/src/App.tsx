import { For, Show, Suspense, batch, createEffect, createMemo, createSignal, lazy, onCleanup, onMount } from "solid-js";
import type { TerminalOpenRequest } from "./components/TerminalPane";
import type { ProjectSearchMatch } from "./lib/project-search";
import type { EditorDocumentChange, EditorSettings, GoToLineRequest, SearchRequest } from "./components/EditorPane";
import { WorkbenchTabs, workbenchTabId, WORKBENCH_EDITOR_PANEL_ID, WORKBENCH_HISTORY_PANEL_ID, WORKBENCH_HISTORY_TAB_ID } from "./components/WorkbenchTabs";
import { SidebarTabs, SIDEBAR_EXPLORER_PANEL_ID, SIDEBAR_EXPLORER_TAB_ID, SIDEBAR_GIT_PANEL_ID, SIDEBAR_GIT_TAB_ID } from "./components/SidebarTabs";
import { Icon, LanguageIcon, languageIconForPath } from "./components/Icons";
import type { PluginQuickPickItem } from "./components/PluginQuickPickDialog";
import { TopbarMenu, TopbarMenuItem } from "./components/TopbarMenu";
import type { ProjectWorkspaceState } from "./lib/project-workspace";
import { projectAfterClose, projectTabLabel, reorderProjects } from "./lib/project-tabs";
import { WindowControls } from "./components/WindowControls";
import { version as appVersion } from "../package.json";
import { checkForUpdates, updateStatus } from "./lib/app-update";
import { defaultSettings } from "./lib/settings";
import { getStartupFolder } from "./lib/bridge";
import { cancelWorkspaceOperations, createGitWorktree, getGitBranches, getGitCommitDiff, getGitCommitFiles, getGitCommits, getGitDiff, getGitStatus, getGitIgnoredPaths, isTauri, listDirectory, cancelDirectoryListing, openFolder, openFileDialog, openNewWindow, pathExists, performGitAction, readFile, saveFile, saveFileAs, saveFileDialog, inspectSaveAsDestination, startWatcher, statFiles, stopWatcher, createDirectory, createFile, deletePath, renamePath, readPluginEntry, revealInFileManager, inspectPluginInstall, commitPluginInstall, cancelPluginInstall, rollbackPluginUpdate, uninstallPlugin, retryPluginCleanup, recoverPluginUpdates, canonicalizeWorkspaceRoot, pluginWorkspaceList, pluginWorkspaceReadFile, pluginWorkspaceFileInfo, pluginWorkspaceReadFileRange, pluginWorkspaceReleaseFileRead, pluginWorkspaceWriteFile, pluginGitDiff, authorizePluginNetwork, pluginNetworkRequest, cancelPluginNetworkRequest, resolvePluginLspServer, approveLspServer, revokeLspServer, startLspServer, sendLspMessage, cancelLspRequest, stopLspServer, stopPluginLsp, stopWorkspaceLsp, revokePluginNetwork } from "./lib/bridge";
import { loadedExplorerPaths } from "./lib/explorer-ignored";
import { errorMessage, orderTabsByPinned } from "./lib/core";
import { emitDiagnostic } from "./lib/diagnostics";
import { contentFingerprint } from "./lib/fingerprint";
import { windowTitleForWorkspace } from "./lib/window-title";
import { pathComparisonKey, samePath as samePathIdentity, isSameOrDescendantPath as isDescendantIdentity, runtimePathOptions, wireBasename, wireParentPath, joinWirePath } from "./lib/path-identity";
import { utf8ByteLength, serializedDocumentByteLength } from "./lib/document-size";
import { isImeComposing } from "./lib/keyboard-input";
import { isMissingFileReadError } from "./lib/file-read-errors";
import { sameEditorSettings } from "./lib/editor-settings";
import { advanceOpenFolderChord, relativePathWithinRoot, type OpenFolderChordState } from "./lib/explorer-actions";
import { deleteConfirmationMessage, trashLocationLabel } from "./lib/delete-confirmation";
import { fileLanguageForPath, isImagePath, lineEndingFromMap, lineEndingMapForContent, normalizeDocumentContent, normalizeLineEndingMap, sameTextMetadata } from "./lib/file-metadata";
import { clampSetting, validateSettings } from "./lib/settings";
import { allGitDirtyState, classifyGitChanges, emptyGitDirtyState, gitRefreshDelay, hasGitDirtyState, mergeGitDirtyState, type GitDirtyState } from "./lib/git-scheduler";
import { BUILTIN_COMMANDS } from "./lib/builtin-commands";
import type { CommandPaletteItem } from "./lib/plugin-activation";
import { parseInstalledPlugin } from "./lib/plugin-manifest";
import type { PluginApiV2Dependencies, PluginApiV2InstalledPlugin, PluginApiV2Permission } from "./lib/plugin-api-v2";
import type { PluginRun, createPluginHostController } from "./lib/plugin-host";
import type { PluginEditorRevisionTracker } from "./lib/plugin-editor-revisions";
import type { PluginAuthorizationManager, PluginAuthorizationReviewManifest, PluginAuthorizationStore, PluginPermissionGrant, PluginPermissionGrantRequest, PluginPermissionResourceScope } from "./lib/plugin-authorization";
import { createRestoreIntent, markRestoreTabCancelled, markRestoreTabStarted, markUserOpenedPath, shouldMergeRestoredTab, type RestoreIntent } from "./lib/restore-state";
import type { DirectoryRestoreOptions, DirectoryRestoreResult } from "./lib/directory-restore";
import type { SaveController, SaveSnapshot } from "./lib/save-controller";
import { savedTabChanges } from "./lib/saved-tab-state";
import { diskMetadataChanged } from "./lib/disk-metadata";
import { markStartupEvent } from "./lib/startup-timeline";
import { limitIo, IoLimiter, IoStaleGenerationError, withBusyRetry } from "./lib/io-limiter";
import { createExternalConflictController } from "./lib/external-conflict-controller";
import { createDocumentController } from "./lib/document-controller";
import { createEditorSelectionFallback, editorSelectionFallbackAfterUpdate } from "./lib/editor-selection-fallback";
import { createWatcherEventBuffer, watcherRetryDelay } from "./lib/watcher-state";
import { attachSessionWindow, claimSessionWindow, closeSessionWindow, collectExpandedPaths, commitSessionCheckpoint, CURSOR_STORAGE_KEY, flushSessionPersistence, listRecoverableSessionCheckpoints, MAX_RECOVERY_BYTES, readLatestSessionCheckpoint, readLatestSessionCheckpointStatus, readSessionRegistry, recoveryStorageKey, readStorage, removeRecoveryStorage, scopedStorageKey, serializeCursorPositions, SESSION_STORAGE_KEY, SESSION_WINDOW_LEASE_MS, heartbeatSessionWindow, writeStorage, removeStorage, type CursorPosition, type PersistedTab, type ProjectSessionMetadata, type RecoveryBaseline, type RecoverySnapshot, type SessionCheckpoint, type SessionMetadata, type SessionWindowLease } from "./lib/session-storage";
import type { StartupSessionSelection } from "./lib/session-startup";
import { createSessionLeaseReleaseQueue } from "./lib/session-lease-release";
import { setRecoveryDatabaseBlockedHandler } from "./lib/recovery-database-status";
import { RecoveryWriteScheduler } from "./lib/recovery-scheduler";
import type { DirectoryRefreshCoordinator } from "./lib/directory-refresh";
import type { GitHistoryController } from "./lib/git-history-controller";
import type { VersionedFileReader } from "./lib/versioned-file-reader";
import { createExpandedPathsCache } from "./lib/expanded-paths";
import type { RestoredTabRecord, RestoredTabResult } from "./lib/session-restore-documents";
import { reconcile, createStore } from "solid-js/store";
import type { AppSettings, DirectoryEntry, DiffResult, EditorTab, FileChange, FileChangedEvent, GitActionRequest, GitBranch, GitCommit, GitCommitFile, GitFileStatus, GitStatusResult, InstalledPlugin, PluginLspServer, ReadFileResult, WatchRoot } from "./types";
import type { PluginInstallPlan } from "./lib/bridge";
import type { LspEvent } from "./lib/bridge";

type ViewMode = "editor" | "diff" | "history";
type FileContextMenu = { entry: DirectoryEntry; x: number; y: number };
type InputDialogState = {
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  resolve: (value: string | null) => void;
};
type ConfirmationDialogState = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  resolve: (confirmed: boolean) => void;
};
type TabOperationSnapshot = Pick<EditorTab, "id" | "path" | "revision" | "contentVersion">;
type PluginStatusBarItem = { pluginId: string; pluginName: string; id: string; text: string; tooltip?: string };
type PendingPluginQuickPick = {
  id: number;
  title: string;
  placeholder?: string;
  items: PluginQuickPickItem[];
  signal: AbortSignal;
  resolve: (item: PluginQuickPickItem | null) => void;
  onAbort: () => void;
  settled: boolean;
};
type PendingPluginAuthorizationReview = {
  plan: PluginInstallPlan;
  proposed: PluginAuthorizationReviewManifest;
  current?: PluginAuthorizationReviewManifest;
  workspaceRoot: string;
  wasEnabled: boolean;
};
type AppQuitDecision = "save" | "discard" | "preserve";
type AppQuitPreparePayload = { requestId: string };
type AppQuitCommitPayload = { requestId: string; decision: AppQuitDecision };
type AppQuitAbortPayload = { requestId: string; error?: string };
type AppQuitCommitSnapshot = { requestId: string; workspace: string; discardedTabs: EditorTab[]; projects?: ProjectWorkspaceState[] };
const emptyGit: GitStatusResult = { repositoryRoot: "", branch: null, repositoryState: "unknown", headOid: null, files: [], commits: [], error: null };
const PLUGINS_STORAGE_KEY = "pude-plugins-v1";
const windowPlatform = detectWindowPlatform();
const initialRecentProjects = loadRecentProjects();
const loadEditorChunk = () => import("./components/EditorPane");
let editorChunkPromise: ReturnType<typeof loadEditorChunk> | undefined;
const getEditorChunk = () => {
  editorChunkPromise ??= loadEditorChunk();
  return editorChunkPromise;
};
const LazyProjectTabs = lazy(async () => ({ default: (await import("./components/ProjectTabs")).ProjectTabs }));
const LazyEditorPane = lazy(async () => {
  const module = await getEditorChunk();
  return { default: module.EditorPane };
});
const LazyProjectSearch = lazy(async () => ({ default: (await import("./components/ProjectSearch")).ProjectSearch }));
const LazyFileContextMenu = lazy(async () => ({ default: (await import("./components/FileContextMenu")).FileContextMenu }));
const LazyExplorer = lazy(async () => ({ default: (await import("./components/Explorer")).Explorer }));
const LazyRecentProjectsList = lazy(async () => ({ default: (await import("./components/RecentProjectsList")).RecentProjectsList }));
// MS-01: these milestones can only be reported once per window.
let startupFirstTabReadyMarked = false;
let startupWatcherReadyMarked = false;
const LazyDiffPane = lazy(async () => ({ default: (await import("./components/DiffPane")).DiffPane }));
const LazyGitPanel = lazy(async () => ({ default: (await import("./components/GitPanel")).GitPanel }));
const LazyMarkdownPreview = lazy(async () => ({ default: (await import("./components/MarkdownPreview")).MarkdownPreview }));
const LazyImagePreview = lazy(async () => ({ default: (await import("./components/ImagePreview")).ImagePreview }));
const LazyPluginModal = lazy(async () => ({ default: (await import("./components/PluginModal")).PluginModal }));
const LazyPluginAuthorizationDialog = lazy(async () => ({ default: (await import("./components/PluginAuthorizationDialog")).PluginAuthorizationDialog }));
const LazyPluginAuthorizationManagementDialog = lazy(async () => ({ default: (await import("./components/PluginAuthorizationDialog")).PluginAuthorizationManagementDialog }));
const LazyTerminalPane = lazy(async () => ({ default: (await import("./components/TerminalPane")).TerminalPane }));
// These dialogs sit on rarely-used UI paths; keep them out of the entry
// chunk. CloseWindowDialog is the exception — closing the window must work
// instantly — so it is preloaded during idle time instead of at startup.
const LazyCommandPalette = lazy(async () => ({ default: (await import("./components/CommandPalette")).CommandPalette }));
const LazySettingsDialog = lazy(async () => ({ default: (await import("./components/SettingsDialog")).SettingsDialog }));
const LazyAboutDialog = lazy(async () => ({ default: (await import("./components/AboutDialog")).AboutDialog }));
const LazyConfirmDialog = lazy(async () => ({ default: (await import("./components/ConfirmDialog")).ConfirmDialog }));
const LazyInputDialog = lazy(async () => ({ default: (await import("./components/InputDialog")).InputDialog }));
const LazyConflictDialog = lazy(async () => ({ default: (await import("./components/ConflictDialog")).ConflictDialog }));
const LazyPluginQuickPickDialog = lazy(async () => ({ default: (await import("./components/PluginQuickPickDialog")).PluginQuickPickDialog }));
let closeWindowDialogChunk: Promise<typeof import("./components/CloseWindowDialog")> | undefined;
const loadCloseWindowDialog = () => (closeWindowDialogChunk ??= import("./components/CloseWindowDialog"));
const LazyCloseWindowDialog = lazy(async () => ({ default: (await loadCloseWindowDialog()).CloseWindowDialog }));
const preloadCloseWindowDialog = () => {
  const schedule = (callback: () => void) => {
    const idleWindow = window as Window & { requestIdleCallback?: (callback: () => void) => number };
    if (typeof idleWindow.requestIdleCallback === "function") idleWindow.requestIdleCallback(callback);
    else window.setTimeout(callback, 0);
  };
  schedule(() => { void loadCloseWindowDialog(); void getWindowApi(); });
};
// The Tauri window API pulls in a large helper chain (Window class,
// dpi, image). It is only needed once the shell is interactive, so load it on
// demand; the idle preload below warms it before the user can click a window
// control or drag the titlebar.
let windowApiPromise: Promise<typeof import("@tauri-apps/api/window")> | undefined;
const invokeQuitCommand = (command: string, args?: Record<string, unknown>) => import("@tauri-apps/api/core").then(({ invoke }) => invoke(command, args));
const getWindowApi = () => (windowApiPromise ??= import("@tauri-apps/api/window"));
// The plugin host libraries (~100 KB of source: sandbox, API v2 proxy,
// authorization, message policy, worker policy, editor revisions, terminal
// bridge, uninstall lifecycle) are only needed when a plugin is installed or
// the plugin UI is opened. App.tsx loads them through this single dynamic
// import so they stay out of the entry chunk; authorization is still resolved
// from persisted storage before any permission decision (fail-closed).
const loadPluginHost = () => import("./lib/plugin-host");
const loadSessionStartupRuntime = () => import("./lib/session-startup");
const resolveSessionStartup = (...args: Parameters<typeof import("./lib/session-startup")["resolveStartupSession"]>) =>
  loadSessionStartupRuntime().then((runtime) => runtime.resolveStartupSession(...args));
const validateStartupCheckpoint = (...args: Parameters<typeof import("./lib/session-startup")["validateStartupCheckpoint"]>) =>
  loadSessionStartupRuntime().then((runtime) => runtime.validateStartupCheckpoint(...args));
type PluginHostModules = Awaited<ReturnType<typeof loadPluginHost>>;
let pluginHostModulesPromise: Promise<PluginHostModules> | undefined;
const getPluginHostModules = () => (pluginHostModulesPromise ??= loadPluginHost());

export default function App() {
  const [workspace, setWorkspace] = createSignal("");
  const [projects, setProjects] = createSignal<ProjectWorkspaceState[]>([]);
  const [activeProjectId, setActiveProjectId] = createSignal<string>();
  const [projectCloseId, setProjectCloseId] = createSignal<string>();
  const [projectCloseBusy, setProjectCloseBusy] = createSignal(false);
  let projectRuntime: typeof import("./lib/project-workspace") | undefined;
  let restoredCheckpointRecoveries: Readonly<Record<string, RecoverySnapshot>> | undefined;
  const [recentProjects, setRecentProjects] = createSignal(initialRecentProjects);
  const [root, setRoot] = createSignal<DirectoryEntry>(makeRecentProjectsRoot(initialRecentProjects));
  // The directory tree is immutable, so caching expanded paths by root
  // identity is equivalent to incremental maintenance and self-invalidates on
  // any rebuild, relist or expand/collapse.
  const expandedPathsCache = createExpandedPathsCache(collectExpandedPaths);
  const currentExpandedPaths = (): string[] => expandedPathsCache.current(root());
  const [tabOrder, setTabOrder] = createSignal<string[]>([]);
  const [tabById, setTabById] = createStore<Record<string, EditorTab>>({});
  const [activeTabId, setActiveTabId] = createSignal<string>();
  let activeTabSelectionGeneration = 0;
  const setActiveTab = (tabId: string | undefined) => {
    if (activeTabId() !== tabId) activeTabSelectionGeneration += 1;
    setActiveTabId(tabId);
  };
  const [viewMode, setViewMode] = createSignal<ViewMode>("editor");
  const [historyTabOpen, setHistoryTabOpen] = createSignal(false);
  const [diffReturnToHistory, setDiffReturnToHistory] = createSignal(false);
  const historyViewActive = () => viewMode() === "history" || viewMode() === "diff" && diffReturnToHistory();
  const [git, setGit] = createSignal<GitStatusResult>(emptyGit);
  const [gitBranches, setGitBranches] = createSignal<GitBranch[]>([]);
  const [gitHistoryLoading, setGitHistoryLoading] = createSignal(false);
  const [gitHistoryLoadingOlder, setGitHistoryLoadingOlder] = createSignal(false);
  const [gitHistoryHasMore, setGitHistoryHasMore] = createSignal(false);
  const [gitHistoryIncomplete, setGitHistoryIncomplete] = createSignal<string>();
  const [diffContextLoading, setDiffContextLoading] = createSignal(false);
  const [sidebarView, setSidebarView] = createSignal<"explorer" | "git">("explorer");
  const [projectSearchOpen, setProjectSearchOpen] = createSignal(false);
  const [terminalOpenRequests, setTerminalOpenRequests] = createSignal<Record<string, TerminalOpenRequest>>({});
  let terminalOpenRequestId = 0;
  const [terminalOpen, setTerminalOpen] = createSignal(false);
  const [terminalInitialized, setTerminalInitialized] = createSignal(false);
  const hideTerminal = () => {
    setTerminalOpen(false);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".cm-content")?.focus({ preventScroll: true }));
  };
  const toggleTerminal = () => {
    const next = !terminalOpen();
    if (next) {
      if (!hydrated()) return;
      if (!activeProjectId()) {
        const project = createProject("");
        setProjects((items) => [...items, project]);
        setActiveProjectId(project.id);
        markSessionDirty();
      }
      setTerminalInitialized(true);
      setTerminalOpen(true);
    } else hideTerminal();
  };
  const [pluginsOpen, setPluginsOpen] = createSignal(false);
  const [aboutOpen, setAboutOpen] = createSignal(false);
  let helpMenuTrigger: HTMLButtonElement | undefined;
  let viewMenuTrigger: HTMLButtonElement | undefined;
  let editMenuTrigger: HTMLButtonElement | undefined;
  const [commandPaletteOpen, setCommandPaletteOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [topbarMenu, setTopbarMenu] = createSignal<"file" | "edit" | "view" | "help">();
  const [closePromptOpen, setClosePromptOpen] = createSignal(false);
  const [closeSaving, setCloseSaving] = createSignal(false);
  const [appQuitPrepared, setAppQuitPrepared] = createSignal(false);
  const [confirmedOperationInProgress, setConfirmedOperationInProgress] = createSignal(false);
  const [plugins, setPlugins] = createSignal<InstalledPlugin[]>(loadPlugins());
  const [pluginsRecovered, setPluginsRecovered] = createSignal(!isTauri);
  // The authorization manager lives in the lazily-loaded plugin host.
  // It is created as soon as any plugin is installed, or when the plugin UI or
  // an install/review flow needs it. Until then the store signal is empty,
  // which matches a persisted store with no installed plugins.
  let authorizationManager: PluginAuthorizationManager | undefined;
  let authorizationManagerPromise: Promise<PluginAuthorizationManager> | undefined;
  let pluginController: ReturnType<typeof createPluginHostController> | undefined;
  // Set once the plugin host chunk has loaded, so synchronous consumers (the
  // command palette item list) can fall back until then.
  const [pluginHostModules, setPluginHostModules] = createSignal<PluginHostModules>();
  const [authorizationStore, setAuthorizationStore] = createSignal<PluginAuthorizationStore>({ version: 1, grants: [] });
  const [authorizationReview, setAuthorizationReview] = createSignal<PendingPluginAuthorizationReview>();
  const [authorizationManagementOpen, setAuthorizationManagementOpen] = createSignal(false);
  const [pendingCleanupIds, setPendingCleanupIds] = createSignal<string[]>([]);
  const [pluginStatusItems, setPluginStatusItems] = createSignal<Record<string, PluginStatusBarItem>>({});
  const [activePluginQuickPick, setActivePluginQuickPick] = createSignal<PendingPluginQuickPick>();
  const pluginQuickPickQueue: PendingPluginQuickPick[] = [];
  let pluginQuickPickSequence = 0;
  let pluginOperationInFlight = false;
  const handleAuthorizationChange = (change: import("./lib/plugin-authorization").PluginAuthorizationChange, manager: PluginAuthorizationManager) => {
        setAuthorizationStore(manager.getSnapshot());
        if (change.type === "revoke") {
          nextPluginRunGeneration(change.grant.pluginId);
          stopPluginRun(change.grant.pluginId);
          if (change.grant.permission === "ui.statusBar") clearPluginStatusItems(change.grant.pluginId);
          revokeNativePluginGrant(change.grant);
          return;
        }
        if (change.type === "plugin-revoke") {
          nextPluginRunGeneration(change.pluginId);
          stopPluginRun(change.pluginId);
          clearPluginStatusItems(change.pluginId);
          for (const grant of change.grants) revokeNativePluginGrant(grant);
          void stopPluginLsp(change.pluginId).catch((error) => emitDiagnostic("plugin.cancel", error));
          void revokePluginNetwork(change.pluginId).catch((error) => emitDiagnostic("plugin.cancel", error));
          return;
        }
        if (change.type === "workspace-change") {
          const review = authorizationReview();
          if (review && !pluginOperationInFlight) {
            setAuthorizationReview(undefined);
            void cancelPluginInstall(review.plan.transactionId).catch((error) => emitDiagnostic("plugin.cancel", error));
          }
          invalidateAllPluginRuns();
          if (change.previousWorkspaceRoot) {
            void stopWorkspaceLsp(change.previousWorkspaceRoot).catch((error) => emitDiagnostic("plugin.cancel", error));
            for (const plugin of plugins()) {
              void revokePluginNetwork(plugin.id, change.previousWorkspaceRoot).catch((error) => emitDiagnostic("plugin.cancel", error));
            }
          }
          setPlugins((items) => items.map((plugin) => plugin.status === "active" ? { ...plugin, status: "inactive" } : plugin));
        }
  };
  const ensureAuthorizationManager = async () => {
    if (authorizationManager) return authorizationManager;
    authorizationManagerPromise ??= getPluginHostModules().then((host) => {
      const manager = getPluginController(host).authorization();
      authorizationManager = manager;
      if (!disposed) {
        setPluginHostModules(() => host);
        setAuthorizationStore(manager.getSnapshot());
      }
      return manager;
    });
    return authorizationManagerPromise;
  };
  // Load the plugin host as soon as it can be needed: an installed plugin, or
  // the plugin UI being opened. With no plugins installed none of these code
  // paths can produce an observable effect, so the chunk is never fetched.
  if (plugins().some((plugin) => plugin.enabled)) void ensureAuthorizationManager();
  createEffect(() => {
    if (pluginsOpen() || authorizationManagementOpen()) void ensureAuthorizationManager();
  });
  onCleanup(() => pluginController?.dispose());
  // Until the plugin host chunk is in, only the built-in commands can exist
  // (plugin commands require installed plugins, which force the chunk to load
  // at startup); the list upgrades reactively once the chunk arrives.
  const commandPaletteItems = createMemo(() => {
    const host = pluginHostModules();
    return host ? host.collectCommandPaletteItems(plugins()) : BUILTIN_COMMANDS;
  });
  const [diff, setDiff] = createSignal<DiffResult>();
  const [toast, setToast] = createSignal<string>();
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [replaceOpen, setReplaceOpen] = createSignal(false);
  const [search, setSearch] = createSignal<SearchRequest>({ query: "", replace: "", caseSensitive: false, regexp: false, wholeWord: false, action: null, actionId: 0 });
  const [searchActionTargetTabId, setSearchActionTargetTabId] = createSignal<string>();
  const [goToLine, setGoToLine] = createSignal<GoToLineRequest>();
  const [externalConflicts, setExternalConflicts] = createSignal<EditorTab[]>([]);
  const [settings, setSettings] = createSignal<AppSettings>(loadSettings());
  const [lastClosedTab, setLastClosedTab] = createSignal<EditorTab>();
  const [hydrated, setHydrated] = createSignal(false);
  const [tabMenu, setTabMenu] = createSignal<{ id: string; x: number; y: number }>();
  const [fileMenu, setFileMenu] = createSignal<FileContextMenu>();
  const [markdownPreviewEnabled, setMarkdownPreviewEnabled] = createSignal(false);
  const [gitIgnoredExpanded, setGitIgnoredExpanded] = createSignal(false);
  const [gitIgnoredPaths, setGitIgnoredPaths] = createSignal<ReadonlySet<string>>(new Set());
  const [draggedTabId, setDraggedTabId] = createSignal<string>();
  const [inputDialog, setInputDialog] = createSignal<InputDialogState>();
  const [confirmationDialog, setConfirmationDialog] = createSignal<ConfirmationDialogState>();
  const [windowMaximized, setWindowMaximized] = createSignal(false);
  let contextMenuFocusTarget: HTMLElement | undefined;
  const closeTabMenu = () => setTabMenu(undefined);
  const closeFileMenu = () => setFileMenu(undefined);
  let toastTimer: number | undefined;
  let openFolderChord: OpenFolderChordState = null;
  let cursorPersistTimer: number | undefined;
  let sessionPersistTimer: number | undefined;
  let settingsPersistTimer: number | undefined;
  let gitRefreshTimer: number | undefined;
  let gitRefreshFirstPendingAt: number | undefined;
  let gitRequestVersion = 0;
  let gitRefreshInFlight: Promise<void> | undefined;
  let gitRefreshPendingPath: string | undefined;
  let gitRefreshPendingShowToast = false;
  let gitBranchesWorkspace: string | undefined;
  let gitBranchesDirty = true;
  let gitStatusRevision = 0;
  let gitBranchesRevision = 0;
  let gitHistoryRefreshInFlight: { workspace: string; generation: number; promise: Promise<void> } | undefined;
  let diffRequestVersion = 0;
  let workspaceGeneration = 0;
  let workspaceIoAbort = new AbortController();
  const workspaceIo = new IoLimiter();
  const directoryRequests = new Set<string>();
  let versionedFileReader: VersionedFileReader<ReadFileResult> | undefined;
  const fileReaderOptions = {
    ioLimiter: workspaceIo, readFile: (path, context) => withBusyRetry(() => {
      if (!context || context.signal.aborted || !context.isCurrent()) throw new IoStaleGenerationError();
      return readFile(path);
    }),
    getGeneration: () => workspaceGeneration, getSignal: () => workspaceIoAbort.signal,
    isDisposed: () => disposed, pathKey,
  } satisfies ConstructorParameters<typeof import("./lib/versioned-file-reader")["VersionedFileReader"]>[0];
  let projectRuntimePromise: Promise<typeof import("./lib/project-workspace")> | undefined;
  const loadProjectRuntime = () => projectRuntimePromise ??= import("./lib/project-workspace").then((runtime) => {
    projectRuntime = runtime;
    versionedFileReader = new runtime.VersionedFileReader(fileReaderOptions);
    return runtime;
  });
  const readFileWithIoLimit = (path: string, priority: "normal" | "current-document" = "normal"): Promise<ReadFileResult> => versionedFileReader
    ? versionedFileReader.read(path, priority)
    : loadProjectRuntime().then(() => versionedFileReader!.read(path, priority));
  const listWorkspaceDirectory = (path: string, requestId = `directory-open-${crypto.randomUUID()}`) => {
    const generation = workspaceGeneration;
    const signal = workspaceIoAbort.signal;
    const isCurrent = () => !disposed && generation === workspaceGeneration;
    return workspaceIo.run(async () => {
      directoryRequests.add(requestId);
      try { return await listDirectory(path, requestId); }
      finally { directoryRequests.delete(requestId); }
    }, { signal, isCurrent });
  };
  const cancelWorkspaceReads = (preserveRestore = false) => {
    if (!preserveRestore && restoreIntent?.pendingTabIds.size && (!sessionRestoreCheckpointVerified
      || restoreMetadata?.tabs.some((tab) => tab.dirty && restoreIntent?.pendingTabIds.has(tab.id)))) pauseUnverifiedSessionRecovery();
    workspaceIoAbort.abort();
    versionedFileReader?.reset();
    workspaceIoAbort = new AbortController();
    for (const requestId of directoryRequests) void cancelDirectoryListing(requestId).catch(() => undefined);
    invalidateDirectoryRefresh();
  };
  let findInputRef: HTMLInputElement | undefined;
  let replaceInputRef: HTMLInputElement | undefined;
  let watcherSessionId: string | undefined;
  let watcherRestartVersion = 0;
  let watcherRestarting = false;
  let watcherNeedsRestart = false;
  let watcherRetryTimer: number | undefined;
  let watcherRetryAttempt = 0;
  let watcherOperationQueue: Promise<unknown> = Promise.resolve();
  let lastFileEventSequence = 0;
  let lastFocusResumeRefreshAt = 0;
  let watcherRoots: WatchRoot[] = [];
  const watcherEvents = createWatcherEventBuffer();
  let fileEventHandler: ((event: FileChangedEvent) => void) | undefined;
  // `filesystem-changed` arrives on a per-session channel created
  // inside startWatcher; every watcher (re)start binds a fresh channel to this
  // dispatcher.
  const handleFileChangeEvent = (event: FileChangedEvent) => {
    const record = watcherEvents.record(event);
    if (record.dispatch) fileEventHandler?.(record.needsRescan ? { ...event, needsRescan: true } : event);
  };
  let disposed = false;
  let dialogRequestInFlight = false;
  let gitMutationInFlight = false;
  let gitDirtyState: GitDirtyState = allGitDirtyState();
  let sessionStorageWarningShown = false;
  let recoveryStorageWarningShown = false;
  let pluginStorageWarningShown = false;
  let sessionScope = "default";
  let sessionStorageKey = SESSION_STORAGE_KEY;
  let cursorStorageKey = CURSOR_STORAGE_KEY;
  let sessionWindowId = "default";
  let sessionLease: SessionWindowLease | undefined;
  let closeCleanupGeneration = 0;
  let sessionHeartbeatTimer: number | undefined;
  let sessionLeaseWarningShown = false;
  let sessionPersistenceBlocked = false;
  let sessionStartupUnavailable = false;
  let sessionPersistenceWarningShown = false;
  let appQuitRequestId: string | undefined;
  let appQuitDecision: AppQuitDecision | undefined;
  let appQuitCommitSnapshot: AppQuitCommitSnapshot | undefined;
  let watcherExcludesKey: string | undefined;
  let watcherOpenFilesKey: string | undefined;
  let restoreIntent: RestoreIntent | undefined;
  let restoreMetadata: SessionMetadata | undefined;
  let sessionRestoreCheckpointVerified = false;
  const documentController = createDocumentController({
    createRevision: () => {
      const [read, setRevision] = createSignal(0);
      return { read, bump: () => setRevision((value) => value + 1) };
    },
    getAdditionalCacheBytes: () => projectRuntime?.projectCacheBytes(allLoadedTabs(), currentProjects()) ?? 0,
  });
  const recoveryScheduler = new RecoveryWriteScheduler();
  const recoveryWriteRevisions = new Map<string, number>();
  const checkpointedRecoveryRevisions = new Map<string, { path: string; revision: number }>();
  /** Saved baselines already durable, keyed by recovery key. */
  const checkpointedBaselines = new Map<string, number>();
  const pendingRecoverySnapshots = new Map<string, RecoverySnapshot>();
  const pendingRecoveryRemovals = new Set<string>();
  const unavailableRecoveryKeys = new Set<string>();
  const fileReadRevisions = new Map<string, number>();
  let directoryRefreshCoordinator: DirectoryRefreshCoordinator | undefined;
  let directoryRefreshPromise: Promise<DirectoryRefreshCoordinator> | undefined;
  let directoryRefreshEpoch = 0;
  const getDirectoryRefreshCoordinator = (): Promise<DirectoryRefreshCoordinator> => {
    if (directoryRefreshCoordinator) return Promise.resolve(directoryRefreshCoordinator);
    if (!directoryRefreshPromise) {
      const pending = import("./lib/directory-refresh").then(({ DirectoryRefreshCoordinator: Coordinator }) => {
        const coordinator = new Coordinator({
          getGeneration: () => workspaceGeneration,
          getWorkspace: workspace,
          isDisposed: () => disposed,
          pathKey,
          isPathInWorkspace: isSameOrDescendantPath,
          isWorkspaceRoot: samePath,
          isExpanded: (path, currentWorkspace) => samePath(path, currentWorkspace) || findDirectoryEntry(root(), path)?.expanded === true,
          markStale: (path) => setRoot((current) => markDirectoryStale(current, path)),
          list: listWorkspaceDirectory,
          apply: (path, listing) => setRoot((current) => samePath(path, current.path)
            ? { ...current, children: mergeDirectoryState(current.children, listing.entries), loaded: true, stale: false, partialError: listing.partialError ?? undefined, incomplete: listing.incomplete, listingStopReason: listing.stopReason }
            : updateEntry(current, path, (entry) => ({ ...entry, children: mergeDirectoryState(entry.children, listing.entries), loaded: true, stale: false, partialError: listing.partialError ?? undefined, incomplete: listing.incomplete, listingStopReason: listing.stopReason, expanded: true }))),
          onError: (path, error) => {
            setRoot((current) => updateEntry(markDirectoryStale(current, path), path, (entry) => ({ ...entry, partialError: { kind: "metadata", message: errorMessage(error, "Unable to read directory.") } })));
            notify("Unable to refresh workspace directory.");
          },
          cancelDirectoryListing,
        });
        directoryRefreshCoordinator = coordinator;
        if (disposed) coordinator.dispose();
        return coordinator;
      }).catch((error: unknown) => {
        if (directoryRefreshPromise === pending) directoryRefreshPromise = undefined;
        throw error;
      });
      directoryRefreshPromise = pending;
    }
    return directoryRefreshPromise;
  };
  const invalidateDirectoryRefresh = (path?: string) => {
    directoryRefreshEpoch += 1;
    directoryRefreshCoordinator?.invalidate(path);
  };
  const disposeDirectoryRefresh = () => {
    directoryRefreshEpoch += 1;
    directoryRefreshCoordinator?.dispose();
  };
  const externalWatchParents = new Set<string>();
  const recoveryKey = (tabId: string) => recoveryStorageKey(tabId, sessionScope);
  let gitHistoryController: GitHistoryController | undefined;
  let gitHistoryControllerPromise: Promise<GitHistoryController> | undefined;
  const getGitHistoryController = (): Promise<GitHistoryController> => {
    if (gitHistoryController) return Promise.resolve(gitHistoryController);
    if (!gitHistoryControllerPromise) {
      const pending = import("./lib/git-history-controller").then(({ GitHistoryController: Controller }) => {
        const controller = new Controller({
          getWorkspace: () => workspace() || null,
          getSnapshotKey: () => git().repositoryRoot ? gitSnapshotKey(git()) : null,
          getCurrentCommits: () => git().commits,
          setCommits: (commits) => setGit((status) => ({ ...status, commits })),
          onState: (state) => {
            setGitHistoryLoading(state.loading);
            setGitHistoryLoadingOlder(state.loadingOlder);
            setGitHistoryHasMore(state.hasMore);
            setGitHistoryIncomplete(state.incomplete);
          },
          onLoaded: () => { gitDirtyState = { ...gitDirtyState, history: false }; },
          notify: (message) => notify(message),
          loadPage: getGitCommits,
        });
        gitHistoryController = controller;
        if (disposed) controller.dispose();
        return controller;
      }).catch((error: unknown) => {
        if (gitHistoryControllerPromise === pending) gitHistoryControllerPromise = undefined;
        throw error;
      });
      gitHistoryControllerPromise = pending;
    }
    return gitHistoryControllerPromise;
  };
  const resetGitHistoryPagination = () => gitHistoryController?.invalidate();
  const invalidateGitHistory = () => {
    gitHistoryController?.invalidate();
    gitDirtyState = { ...gitDirtyState, history: true };
  };

  const enqueueWatcherOperation = <T,>(operation: () => Promise<T>): Promise<T> => {
    const queued = watcherOperationQueue.catch(() => undefined).then(operation);
    watcherOperationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  };

  const clearWatcherRetry = () => {
    if (watcherRetryTimer) window.clearTimeout(watcherRetryTimer);
    watcherRetryTimer = undefined;
    watcherRetryAttempt = 0;
  };

  const flushBufferedWatcherEvents = () => {
    const pending = watcherEvents.endBuffering();
    if (pending.needsRescan && fileEventHandler) {
      fileEventHandler({ paths: workspace() ? [workspace()] : [], changes: [], needsRescan: true });
    }
    for (const event of pending.events) fileEventHandler?.(event);
  };

  const scheduleWatcherRetry = (generation: number) => {
    if (watcherRetryTimer || disposed || generation !== workspaceGeneration) return;
    const delay = watcherRetryDelay(watcherRetryAttempt);
    watcherRetryAttempt += 1;
    watcherRetryTimer = window.setTimeout(() => {
      watcherRetryTimer = undefined;
      if (!disposed && generation === workspaceGeneration) void restartWatcher();
    }, delay);
  };

  const restartWatcher = async () => {
    const currentWorkspace = workspace();
    const generation = workspaceGeneration;
    if ((!currentWorkspace && !externalWatchParents.size) || !isTauri || disposed) return;
    if (watcherRestarting) return;
    if (watcherRetryTimer) {
      window.clearTimeout(watcherRetryTimer);
      watcherRetryTimer = undefined;
    }
    const restartVersion = ++watcherRestartVersion;
    watcherRestarting = true;
    watcherEvents.beginBuffering();
    try {
      await enqueueWatcherOperation(async () => {
        if (disposed || generation !== workspaceGeneration || workspace() !== currentWorkspace) return;
        await stopWatcher();
        watcherSessionId = undefined;
        watcherEvents.resetSequence();
        const nextSessionId = await startWatcher(currentWorkspace, [...externalWatchParents], settings().watcherExcludes, tabs().filter((tab) => tab.language !== "Image").map((tab) => tab.path), handleFileChangeEvent);
        if (disposed || generation !== workspaceGeneration || workspace() !== currentWorkspace || restartVersion !== watcherRestartVersion) {
          await stopWatcher(nextSessionId);
          return;
        }
        watcherSessionId = nextSessionId;
        watcherNeedsRestart = false;
        lastFileEventSequence = 0;
        watcherRetryAttempt = 0;
        relistAllDirectories();
        verifyOpenFiles();
        scheduleGitRefresh(allGitDirtyState());
      });
      if (generation === workspaceGeneration && !disposed) flushBufferedWatcherEvents();
    } catch (error) {
      watcherNeedsRestart = true;
      if (!disposed && generation === workspaceGeneration) {
        notify(errorMessage(error, "Unable to update file watcher."));
        scheduleWatcherRetry(generation);
      }
    } finally {
      if (restartVersion === watcherRestartVersion) watcherRestarting = false;
    }
  };

  const syncExternalWatchParents = () => {
    const next = new Set(
      tabs()
        .filter((tab) => !workspace() || !isSameOrDescendantPath(tab.path, workspace()))
        .map((tab) => parentPath(tab.path)),
    );
    const changed = next.size !== externalWatchParents.size || [...next].some((path) => !externalWatchParents.has(path));
    const openFilesKey = tabs().map((tab) => pathKey(tab.path)).sort().join("\u0000");
    // Treat the first post-start sync as a configuration change too. This is
    // needed when the watcher started before the first tab was opened: an
    // open file inside an excluded directory must become an explicit native
    // watcher exception.
    const openFilesChanged = watcherOpenFilesKey !== openFilesKey;
    watcherOpenFilesKey = openFilesKey;
    if (!changed && !openFilesChanged) return;
    externalWatchParents.clear();
    next.forEach((path) => externalWatchParents.add(path));
    if (!hydrated()) return;
    void restartWatcher();
  };

  const tabs = createMemo(() => {
    const byId = tabById;
    return tabOrder().map((id) => byId[id]).filter((tab): tab is EditorTab => Boolean(tab));
  });
  const compactRecoverySnapshot = (...args: Parameters<typeof import("./lib/session-storage-schema")["compactRecoverySnapshot"]>) => projectRuntime!.compactRecoverySnapshot(...args);
  const recoverySnapshotSizeBytes = (...args: Parameters<typeof import("./lib/session-storage-schema")["recoverySnapshotSizeBytes"]>) => projectRuntime!.recoverySnapshotSizeBytes(...args);
  const allLoadedTabs = () => Object.values(tabById).filter((tab): tab is EditorTab => Boolean(tab));
  const createProject = (path: string, id: string = crypto.randomUUID()): ProjectWorkspaceState => projectRuntime!.createProject(id, path,
    path ? { name: baseName(path), path, kind: "directory", expanded: true, loaded: false } : makeRecentProjectsRoot(recentProjects()));
  const captureProject = (): ProjectWorkspaceState => ({
    id: activeProjectId()!, workspace: workspace(), root: root(), tabIds: [...tabOrder()], activeTabId: activeTabId(),
    viewMode: viewMode(), historyTabOpen: historyTabOpen(), diffReturnToHistory: diffReturnToHistory(), diff: diff(),
    git: git(), gitBranches: gitBranches(), sidebarView: sidebarView(), search: { ...search(), action: null },
    searchOpen: searchOpen(), replaceOpen: replaceOpen(), markdownPreviewEnabled: markdownPreviewEnabled(), gitIgnoredExpanded: gitIgnoredExpanded(), lastClosedTab: lastClosedTab(),
    terminalOpen: terminalOpen(), terminalInitialized: terminalInitialized(), restoreMetadata, restoreIntent, conflicts: externalConflicts(),
  });
  const currentProjects = () => projects().map((project) => project.id === activeProjectId() ? captureProject() : project);
  const projectSession = (project: ProjectWorkspaceState): ProjectSessionMetadata => projectRuntime!.projectSession(project, (id) => tabById[id], pathKey, expandedPathsCache.current);
  const windowSession = (): SessionMetadata => projectRuntime
    ? projectRuntime.createWindowSessionMetadata(currentProjects().map(projectSession), activeProjectId())
    : { version: 3, workspace: "", tabs: [], expandedPaths: [], projects: [] };
  const windowHasDirtyTabs = () => currentProjects().some((project) => projectRuntime?.projectHasDirtyTabs(project, (id) => tabById[id], pathKey));
  // Only depends on what the header shows, so git, search and tree updates do not re-render the tabs.
  const projectTabItems = createMemo(() => {
    const activeId = activeProjectId();
    const items = projects().map((project) => project.id === activeId
      ? { ...project, workspace: workspace(), tabIds: tabOrder(), restoreMetadata, restoreIntent }
      : project);
    return items.map((project) => ({
      id: project.id, workspace: project.workspace, label: projectTabLabel(project, items),
      dirty: projectRuntime?.projectHasDirtyTabs(project, (id) => tabById[id], pathKey) ?? false,
    }));
  });
  const setTabs = (next: EditorTab[] | ((items: EditorTab[]) => EditorTab[])) => {
    const resolved = typeof next === "function" ? next(tabs()) : next;
    const ordered = orderTabsByPinned(resolved);
    batch(() => {
      if (!activeProjectId() && ordered.length) {
        const project = createProject(workspace());
        setProjects((items) => [...items, project]);
        setActiveProjectId(project.id);
      }
      const ids = new Set(ordered.map((tab) => tab.id));
      for (const id of tabOrder()) if (!ids.has(id)) setTabById(id, undefined!);
      for (const tab of ordered) setTabById(tab.id, reconcile(tab));
      setTabOrder(ordered.map((tab) => tab.id));
    });
  };
  const captureTabOperation = (tab: EditorTab): TabOperationSnapshot => ({ id: tab.id, path: tab.path, revision: tab.revision, contentVersion: tab.contentVersion });
  const tabOperationIsCurrent = (snapshot: TabOperationSnapshot) => {
    const current = tabById[snapshot.id];
    return Boolean(current && current.path === snapshot.path && current.revision === snapshot.revision && current.contentVersion === snapshot.contentVersion);
  };
  const tabOperationsAreCurrent = (snapshots: TabOperationSnapshot[]) => snapshots.every(tabOperationIsCurrent);
  const sameTabOperations = (left: TabOperationSnapshot[], right: TabOperationSnapshot[]) => left.length === right.length
    && left.every((snapshot, index) => snapshot.id === right[index]?.id
      && snapshot.path === right[index]?.path
      && snapshot.revision === right[index]?.revision
      && snapshot.contentVersion === right[index]?.contentVersion);
  const updateSettings = (changes: Partial<AppSettings>) => setSettings((current) => ({ ...current, ...changes }));
  const editorSettings = createMemo<EditorSettings>(() => ({ theme: settings().theme, fontSize: settings().fontSize, tabSize: settings().tabSize, insertSpaces: settings().insertSpaces, wordWrap: settings().wordWrap }), { theme: settings().theme, fontSize: settings().fontSize, tabSize: settings().tabSize, insertSpaces: settings().insertSpaces, wordWrap: settings().wordWrap }, { equals: sameEditorSettings });
  const getDocumentRevision = documentController.getRevision;
  let documentCacheTimer: number | undefined;
  let documentCacheWarningShown = false;
  const scheduleDocumentCacheBudget = () => {
    if (documentCacheTimer !== undefined) window.clearTimeout(documentCacheTimer);
    documentCacheTimer = window.setTimeout(() => {
      documentCacheTimer = undefined;
      if (disposed) return;
      const status = documentController.enforceCacheBudget(undefined, (tabId, seed) => {
        const tab = tabById[tabId];
        if (!tab || tab.revision !== seed.revision || tab.contentVersion !== seed.sourceVersion || tab.dirty) return false;
        const selectionFallback = createEditorSelectionFallback(seed.selectionJSON, seed.revision, seed.sourceVersion, seed.content.length);
        if (!selectionFallback) return false;
        updateTab(tabId, {
          content: seed.content, savedContent: seed.savedContent,
          lineEndings: seed.lineEndings, savedLineEndings: seed.savedLineEndings,
          lineEnding: seed.lineEnding, bom: seed.bom, savedBom: seed.savedBom,
          encoding: seed.encoding, savedRevision: seed.savedRevision,
          normalizedContentVersion: seed.sourceVersion, normalizedSavedRevision: seed.savedRevision,
          estimatedBytes: seed.estimatedBytes, largeFile: seed.largeFile,
          cursorLine: seed.cursor?.line ?? tab.cursorLine, cursorColumn: seed.cursor?.column ?? tab.cursorColumn,
          selectionFallback,
        });
        return true;
      });
      if (status.overBudget && !documentCacheWarningShown) {
        notify("Editor memory exceeds the cache budget. Documents that cannot be safely rebuilt are being retained.");
      }
      documentCacheWarningShown = status.overBudget;
    }, 250);
  };
  const registerDocument: typeof documentController.register = (tabId, handle) => {
    documentController.register(tabId, handle);
    scheduleDocumentCacheBudget();
  };
  const unregisterDocument: typeof documentController.unregister = (tabId, handle) => {
    documentController.unregister(tabId, handle);
    scheduleDocumentCacheBudget();
  };
  const getDocumentText = documentController.getText;
  const getActiveDocumentText = () => {
    const tabId = activeTabId();
    if (!tabId) return "";
    documentController.getRevision(tabId).read();
    return documentController.getHandle(tabId)?.getText() ?? tabById[tabId]?.content ?? "";
  };

  const activeTab = createMemo(() => {
    const id = activeTabId();
    return id ? tabById[id] : undefined;
  });
  const loadedPaths = createMemo(() => loadedExplorerPaths(root()), undefined, {
    equals: (left, right) => left.length === right.length && left.every((path, index) => path === right[index]),
  });
  createEffect(() => {
    const currentWorkspace = workspace();
    const repositoryRoot = git().repositoryRoot;
    const paths = loadedPaths();
    let cancelled = false;
    const generation = workspaceGeneration;
    const isCurrent = () => !cancelled && !disposed && generation === workspaceGeneration && currentWorkspace === workspace();
    const timer = window.setTimeout(() => {
      if (!currentWorkspace || !repositoryRoot || !paths.length) {
        if (isCurrent()) setGitIgnoredPaths(new Set<string>());
        return;
      }
      void (async () => {
        const ignored = new Set<string>();
        for (let index = 0; index < paths.length; index += 256) {
          if (!isCurrent()) return;
          const batch = paths.slice(index, index + 256);
          const result = await workspaceIo.run(() => getGitIgnoredPaths(currentWorkspace, batch), {
            signal: workspaceIoAbort.signal, isCurrent,
          });
          for (const path of result) ignored.add(pathKey(path));
        }
        if (isCurrent()) setGitIgnoredPaths(ignored);
      })().catch((error) => { if (isCurrent()) emitDiagnostic("explorer.ignore", error); });
    }, 75);
    onCleanup(() => { cancelled = true; window.clearTimeout(timer); });
  });

  const isMarkdownPreview = () => activeTab()?.language === "Markdown" && !activeTab()?.largeFile && markdownPreviewEnabled();
  const shortcutModifier = () => isMacPlatform() ? "Cmd" : "Ctrl";

  const startWindowDrag = (event: MouseEvent) => {
    if (!isTauri || event.button !== 0 || (event.target as HTMLElement).closest("button, input, textarea, select, a, .project-tab, .settings-dialog-backdrop")) return;
    event.preventDefault();
    if (event.detail === 2) void toggleWindowMaximize();
    else void getWindowApi().then(({ getCurrentWindow }) => getCurrentWindow().startDragging());
  };

  const toggleWindowMaximize = async () => {
    if (!isTauri) return;
    const { getCurrentWindow } = await getWindowApi();
    const currentWindow = getCurrentWindow();
    await currentWindow.toggleMaximize();
    setWindowMaximized(await currentWindow.isMaximized());
  };

  const updateSidebarWidth = (width: number) => updateSettings({ sidebarWidth: clampSetting("sidebarWidth", width, settings().sidebarWidth) });
  let stopSidebarResize = () => undefined;
  const startSidebarResize = (event: PointerEvent) => {
    event.preventDefault();
    stopSidebarResize();
    document.body.classList.add("sidebar-resizing");
    const handleMove = (moveEvent: PointerEvent) => updateSidebarWidth(moveEvent.clientX);
    const handleUp = () => stopSidebarResize();
    stopSidebarResize = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      document.body.classList.remove("sidebar-resizing");
      stopSidebarResize = () => undefined;
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  };

  const nudgeSidebarWidth = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    updateSidebarWidth(settings().sidebarWidth + (event.key === "ArrowRight" ? 16 : -16));
  };

  const checkForUpdatesAfterStartup = async () => {
    await checkForUpdates();
    const status = updateStatus();
    if (status.phase === "available") notify(`pude ${status.version} is available. Open Help > About pude to update.`);
  };

  const notify = (message: string) => {
    setToast(message);
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => setToast(undefined), 2600);
  };

  const pluginStatusItemKey = (pluginId: string, itemId: string) => `${pluginId}\u0000${itemId}`;
  const clearPluginStatusItems = (pluginId: string) => {
    setPluginStatusItems((items) => Object.fromEntries(Object.entries(items).filter(([, item]) => item.pluginId !== pluginId)));
  };
  const activateNextPluginQuickPick = () => {
    if (activePluginQuickPick()) return;
    while (pluginQuickPickQueue.length) {
      const next = pluginQuickPickQueue.shift()!;
      if (!next.settled && !next.signal.aborted) {
        setActivePluginQuickPick(next);
        return;
      }
    }
  };
  const settlePluginQuickPick = (request: PendingPluginQuickPick, item: PluginQuickPickItem | null) => {
    if (request.settled) return;
    request.settled = true;
    request.signal.removeEventListener("abort", request.onAbort);
    const queuedIndex = pluginQuickPickQueue.findIndex((candidate) => candidate.id === request.id);
    if (queuedIndex >= 0) pluginQuickPickQueue.splice(queuedIndex, 1);
    if (activePluginQuickPick()?.id === request.id) {
      setActivePluginQuickPick(undefined);
      activateNextPluginQuickPick();
    }
    request.resolve(item);
  };
  const requestPluginQuickPick = (
    plugin: PluginApiV2InstalledPlugin,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PluginQuickPickItem | null> => {
    if (signal.aborted) return Promise.resolve(null);
    if (pluginQuickPickQueue.length + (activePluginQuickPick() ? 1 : 0) >= 16) {
      throw new Error("Too many plugin quick-pick requests are waiting.");
    }
    return new Promise((resolve) => {
      const request = {
        id: ++pluginQuickPickSequence,
        title: `${plugin.name} — Choose an option`,
        placeholder: params.placeholder as string | undefined,
        items: params.items as PluginQuickPickItem[],
        signal,
        resolve,
        onAbort: () => {},
        settled: false,
      } satisfies PendingPluginQuickPick;
      request.onAbort = () => settlePluginQuickPick(request, null);
      signal.addEventListener("abort", request.onAbort, { once: true });
      pluginQuickPickQueue.push(request);
      activateNextPluginQuickPick();
    });
  };
  const clearPluginQuickPicks = () => {
    const pending = [...pluginQuickPickQueue];
    const active = activePluginQuickPick();
    pluginQuickPickQueue.length = 0;
    setActivePluginQuickPick(undefined);
    if (active) pending.push(active);
    for (const request of pending) {
      if (request.settled) continue;
      request.settled = true;
      request.signal.removeEventListener("abort", request.onAbort);
      request.resolve(null);
    }
  };
  onCleanup(clearPluginQuickPicks);

  const blockSessionPersistence = (message: string) => {
    sessionPersistenceBlocked = true;
    if (disposed || sessionPersistenceWarningShown) return;
    sessionPersistenceWarningShown = true;
    notify(message);
  };

  const unblockSessionPersistence = () => {
    if (!sessionStartupUnavailable && !sessionLeaseReleaseQueue.hasPending()) sessionPersistenceBlocked = false;
  };
  const pauseUnverifiedSessionRecovery = () => {
    sessionStartupUnavailable = true;
    blockSessionPersistence("Recovery could not be verified. Existing data is retained; save new edits manually and restart to retry.");
  };
  const markUserOpenedRestorePath = (path: string) => {
    if (!restoreIntent) return;
    if (restoreMetadata?.tabs.some((tab) => restoreIntent?.pendingTabIds.has(tab.id) && samePath(tab.path, path)
      && (tab.dirty || (!sessionRestoreCheckpointVerified && !isImagePath(tab.path))))) pauseUnverifiedSessionRecovery();
    restoreIntent = markUserOpenedPath(restoreIntent, path);
  };
  const sessionLeaseReleaseQueue = createSessionLeaseReleaseQueue({
    close: (lease) => closeSessionWindow(lease, { discardRecovery: false }),
    onPending: () => blockSessionPersistence("A previous session lease still needs cleanup; unsaved recovery is paused until ownership is resolved."),
    onError: (error) => emitDiagnostic("session.close", error),
  });

  const resolveStartupSession = (windowId: string): Promise<StartupSessionSelection> => {
    const generation = workspaceGeneration;
    return resolveSessionStartup(windowId, {
      confirmStaleRecovery: () => requestConfirmation({ title: "Restore previous changes?", message: "A previous editor window has recoverable changes. Restore them in this window?", confirmLabel: "Restore", cancelLabel: "Not now" }),
      notify,
      isCurrent: () => !disposed && generation === workspaceGeneration,
    });
  };

  const requestInput = (dialog: Omit<InputDialogState, "resolve">): Promise<string | null> => {
    if (dialogRequestInFlight || disposed || closePromptOpen() || appQuitPrepared() || confirmedOperationInProgress()) return Promise.resolve(null);
    dialogRequestInFlight = true;
    return new Promise((resolve) => setInputDialog({ ...dialog, resolve }));
  };
  const closeInputDialog = (value: string | null) => {
    const dialog = inputDialog();
    setInputDialog(undefined);
    if (!dialog) return;
    dialogRequestInFlight = false;
    dialog?.resolve(value);
  };
  const requestConfirmation = (dialog: Omit<ConfirmationDialogState, "resolve">): Promise<boolean> => {
    if (dialogRequestInFlight || disposed || closePromptOpen() || appQuitPrepared() || confirmedOperationInProgress()) return Promise.resolve(false);
    dialogRequestInFlight = true;
    return new Promise((resolve) => setConfirmationDialog({ ...dialog, resolve }));
  };
  const closeConfirmationDialog = (confirmed: boolean) => {
    const dialog = confirmationDialog();
    setConfirmationDialog(undefined);
    if (!dialog) return;
    dialogRequestInFlight = false;
    dialog.resolve(confirmed);
  };
  onCleanup(() => {
    const input = inputDialog();
    const confirmation = confirmationDialog();
    setInputDialog(undefined);
    setConfirmationDialog(undefined);
    dialogRequestInFlight = false;
    input?.resolve(null);
    confirmation?.resolve(false);
  });

  const storeRecentProjects = (paths: string[]) => {
    setRecentProjects(paths);
    writeStorage("pude-recent-projects-v1", JSON.stringify(paths));
  };

  const rememberRecentProject = (path: string) => {
    if (path === "pude-demo") return;
    storeRecentProjects([path, ...recentProjects().filter((item) => item !== path)].slice(0, 8));
  };

  const forgetMissingRecentProjects = async () => {
    const paths = recentProjects();
    const exists = await Promise.all(paths.map((path) => pathExists(path).catch(() => true)));
    const remaining = paths.filter((_, index) => exists[index]);
    if (remaining.length !== paths.length) storeRecentProjects(remaining);
  };
  const recentProjectEntries = createMemo(() => makeRecentProjectsRoot(recentProjects()).children ?? []);

  const createRecoverySnapshot = (tab: EditorTab): RecoverySnapshot => {
    const liveSnapshot = documentController.getHandle(tab.id)?.getSnapshot();
    const content = liveSnapshot?.content ?? normalizeDocumentContent(getDocumentText(tab));
    const lineEndings = liveSnapshot?.lineEndings ?? normalizeLineEndingMap(content, tab.lineEndings, tab.lineEnding);
    // V2 snapshots carry the edited content plus a savedRevision
    // baseline reference. The durable baseline text is written once per
    // savedRevision through createRecoveryBaseline, not duplicated here.
    return {
      version: 2,
      tabId: tab.id,
      path: tab.path,
      revision: liveSnapshot?.revision ?? tab.revision,
      content,
      savedRevision: tab.savedRevision,
      savedContent: "",
      savedContentUnavailable: true,
      lineEnding: liveSnapshot?.lineEnding ?? tab.lineEnding,
      lineEndings,
      savedLineEndings: liveSnapshot?.savedLineEndings ?? normalizeLineEndingMap(tab.savedContent, tab.savedLineEndings ?? tab.lineEndings, tab.lineEnding),
      bom: liveSnapshot?.bom ?? tab.bom === true,
      savedBom: liveSnapshot?.savedBom ?? (tab.savedBom === true || (tab.savedBom === undefined && tab.bom === true)),
      encoding: liveSnapshot?.encoding ?? tab.encoding,
    };
  };

  const createRecoveryBaseline = (tab: EditorTab): RecoveryBaseline => ({
    version: 1,
    tabId: tab.id,
    path: tab.path,
    savedRevision: tab.savedRevision,
    savedContent: tab.savedContent,
    ...(tab.savedLineEndings !== undefined ? { savedLineEndings: tab.savedLineEndings } : {}),
    ...(tab.savedBom !== undefined ? { savedBom: tab.savedBom } : {}),
    ...(tab.encoding !== undefined ? { encoding: tab.encoding } : {}),
  });

  const commitCurrentCheckpoint = async (): Promise<boolean> => {
    if (!hydrated()) return false;
    if (sessionPersistenceBlocked || (!sessionRestoreCheckpointVerified && restoreIntent?.pendingTabIds.size)) {
      // Preserve inaccessible scopes and unresolved standalone recoveries.
      // Legacy clean metadata can still have a newer dirty body. Clean state can
      // close safely while the lease is released or retained by storage.
      return !windowHasDirtyTabs() && pendingRecoverySnapshots.size === 0;
    }
    const commitProjectRevision = currentProjects().map((project) => project.id).join("\0");
    const commitScope = sessionScope;
    const session = windowSession();
    const recoveryByKey = new Map<string, RecoverySnapshot>();
    const baselinesToWrite: RecoveryBaseline[] = [];
    const unavailable = new Set(unavailableRecoveryKeys);
    for (const tab of allLoadedTabs()) {
      if (!tab.dirty) continue;
      const key = recoveryKey(tab.id);
      if (checkpointedBaselines.get(key) !== tab.savedRevision) {
        baselinesToWrite.push(createRecoveryBaseline(tab));
      }
      const pending = pendingRecoverySnapshots.get(key);
      const checkpointed = checkpointedRecoveryRevisions.get(key);
      if (pending && pending.path === tab.path && pending.revision === tab.revision) {
        pendingRecoveryRemovals.delete(key);
        recoveryByKey.set(key, pending);
        continue;
      }
      if (checkpointed && checkpointed.path === tab.path && checkpointed.revision === tab.revision && !pendingRecoveryRemovals.has(key) && !unavailable.has(key)) continue;
      try {
        const snapshot = compactRecoverySnapshot(createRecoverySnapshot(tab));
        if (!snapshot || recoverySnapshotSizeBytes(snapshot) > MAX_RECOVERY_BYTES) {
          unavailable.add(key);
          pendingRecoverySnapshots.delete(key);
        } else {
          pendingRecoveryRemovals.delete(key);
          pendingRecoverySnapshots.set(key, snapshot);
          recoveryByKey.set(key, snapshot);
          unavailable.delete(key);
        }
      } catch (error) {
        emitDiagnostic("recovery.failure", error);
        unavailable.add(key);
        unavailableRecoveryKeys.add(key);
      }
    }
    const result = await commitSessionCheckpoint({
      scope: sessionScope,
      session,
      recoveries: [...recoveryByKey.values()],
      baselines: baselinesToWrite,
      recoveryKeysToRemove: [...pendingRecoveryRemovals],
      protectedRecoveryKeys: session.tabs.filter((tab) => tab.dirty).map((tab) => recoveryKey(tab.id)),
      unavailableRecoveryKeys: [...unavailable],
      lease: sessionLease,
    });
    const isCurrentCommit = commitScope === sessionScope && commitProjectRevision === projects().map((project) => project.id).join("\0");
    if (isCurrentCommit && (result.reason === "invalid" || result.reason === "unavailable")) {
      blockSessionPersistence("Session ownership or recovery storage is unavailable; unsaved recovery is paused.");
    }
    if (isCurrentCommit && !result.ok && !sessionStorageWarningShown) {
      sessionStorageWarningShown = true;
      notify("Session restore state could not be saved.");
    }
    if (isCurrentCommit && !result.complete && result.missingRecoveryKeys.length && !recoveryStorageWarningShown) {
      recoveryStorageWarningShown = true;
      notify("Some unsaved files do not have a durable recovery checkpoint.");
    }
    if (isCurrentCommit && result.ok && result.complete && result.checkpoint) {
      for (const baseline of baselinesToWrite) {
        checkpointedBaselines.set(recoveryKey(baseline.tabId), baseline.savedRevision);
      }
      for (const [key, snapshot] of pendingRecoverySnapshots) {
        const committed = result.updatedRecoveryKeys.includes(key) && recoveryByKey.get(key);
        if (committed && committed.revision === snapshot.revision && committed.path === snapshot.path) {
          checkpointedRecoveryRevisions.set(key, { path: snapshot.path, revision: snapshot.revision });
          pendingRecoverySnapshots.delete(key);
        }
      }
      for (const key of pendingRecoveryRemovals) {
        if (result.removedRecoveryKeys.includes(key)) {
          pendingRecoveryRemovals.delete(key);
          checkpointedRecoveryRevisions.delete(key);
        }
      }
    }
    return isCurrentCommit && result.ok && (result.complete || !windowHasDirtyTabs());
  };

  const persistSession = () => {
    sessionPersistTimer = undefined;
    if (!hydrated()) return;
    void commitCurrentCheckpoint().catch((error) => {
      if (!sessionStorageWarningShown) {
        sessionStorageWarningShown = true;
        notify(errorMessage(error, "Session restore state could not be saved."));
      }
    });
  };

  const scheduleSessionPersistence = () => {
    if (!hydrated() || sessionPersistTimer) return;
    sessionPersistTimer = window.setTimeout(persistSession, 500);
  };

  const markSessionDirty = () => scheduleSessionPersistence();

  const reattachSessionWindow = async (
    workspacePath: string,
    expectedGeneration = workspaceGeneration,
    expectedCloseGeneration = closeCleanupGeneration,
  ) => {
    if (sessionStartupUnavailable) return false;
    if (!await sessionLeaseReleaseQueue.releaseAll()) return false;
    if (disposed || expectedGeneration !== workspaceGeneration || expectedCloseGeneration !== closeCleanupGeneration || workspace() !== workspacePath) return false;
    const attached = await attachSessionWindow({
      windowId: sessionWindowId,
      scope: sessionScope,
      workspace: workspacePath,
      dirtyRecoveryKeys: windowSession().tabs.filter((tab) => tab.dirty).map((tab) => recoveryStorageKey(tab.id, sessionScope)),
    });
    if (expectedGeneration !== workspaceGeneration
      || expectedCloseGeneration !== closeCleanupGeneration
      || workspace() !== workspacePath) {
      if (attached.ok && attached.lease) {
        await sessionLeaseReleaseQueue.release(attached.lease);
      }
      return false;
    }
    if (attached.ok && attached.lease) {
      sessionLease = attached.lease;
      unblockSessionPersistence();
      return true;
    }
    blockSessionPersistence(attached.reason === "conflict"
      ? "This session scope is already owned by another window; unsaved recovery is paused."
      : "Session recovery storage is unavailable; unsaved recovery cannot be protected.");
    return false;
  };

  const pluginRunsFor = (pluginId: string) => pluginController?.runsFor(pluginId) ?? [];
  const stopPluginRun = (pluginId: string, onlyRun?: PluginRun) => pluginController?.stop(pluginId, onlyRun);
  const nextPluginRunGeneration = (pluginId: string) => pluginController?.nextGeneration(pluginId);
  const invalidateAllPluginRuns = () => pluginController?.invalidate();

  const revokeNativePluginGrant = (grant: PluginPermissionGrant) => {
    if (grant.permission === "network") {
      void revokePluginNetwork(grant.pluginId, grant.workspaceRoot ?? undefined).catch((error) => {
        emitDiagnostic("plugin.cancel", error);
      });
    }
    const scope = grant.resourceScope;
    if (grant.permission === "process.spawn:lsp" && scope?.kind === "executable" && grant.workspaceRoot) {
      void revokeLspServer({
        pluginId: grant.pluginId,
        pluginVersion: grant.pluginVersion,
        workspaceRoot: grant.workspaceRoot,
        server: {
          serverId: scope.serverId,
          language: scope.language,
          executable: scope.executablePath,
          args: [...scope.args],
        },
      }).catch((error) => {
        emitDiagnostic("plugin.cancel", error);
      });
    }
  };

  const hasApprovedPluginPermission = async (
    plugin: PluginApiV2InstalledPlugin,
    permission: PluginApiV2Permission,
    scope: { workspaceRoot: string; resourceScope?: PluginPermissionResourceScope },
  ): Promise<boolean> => (await ensureAuthorizationManager()).hasPermission({
    plugin,
    permission,
    workspaceRoot: scope.workspaceRoot,
    resourceScope: scope.resourceScope,
  });

  const declaredLspServer = (plugin: PluginApiV2InstalledPlugin, serverId: string) => {
    const matches = plugin.lspServers?.filter((server) => server.serverId === serverId) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  };

  const resolvePluginLspTarget = async (
    plugin: PluginApiV2InstalledPlugin,
    workspaceRoot: string,
    serverId: string,
  ) => {
    const server = declaredLspServer(plugin, serverId);
    if (!server) throw new Error("Language server is not uniquely declared by this plugin.");
    const resolved = await resolvePluginLspServer(workspaceRoot, server);
    if (resolved.serverId !== server.serverId
        || resolved.language !== server.language
        || JSON.stringify(resolved.args) !== JSON.stringify(server.args)) {
      throw new Error("Language server declaration changed during resolution.");
    }
    return {
      server,
      resolved,
      permissionScope: {
        workspaceRoot: resolved.workspaceRoot,
        resourceScope: {
          kind: "executable" as const,
          serverId: resolved.serverId,
          language: resolved.language,
          executablePath: resolved.executablePath,
          args: [...resolved.args],
        },
      },
    };
  };

  const resolveApiPermission = async (
    plugin: PluginApiV2InstalledPlugin,
    permission: PluginApiV2Permission,
    scope: { workspaceRoot: string; resourceScope?: PluginPermissionResourceScope },
  ): Promise<boolean> => {
    if (permission !== "process.spawn:lsp") return hasApprovedPluginPermission(plugin, permission, scope);
    if (scope.resourceScope?.kind !== "executable") return false;
    try {
      const target = await resolvePluginLspTarget(plugin, scope.workspaceRoot, scope.resourceScope.serverId);
      if (target.server.language !== scope.resourceScope.language
          || target.server.executable !== scope.resourceScope.executablePath
          || JSON.stringify(target.server.args) !== JSON.stringify(scope.resourceScope.args)) return false;
      return hasApprovedPluginPermission(plugin, permission, target.permissionScope);
    } catch {
      return false;
    }
  };

  const persistCursorPositions = () => {
    const positions: Record<string, CursorPosition> = Object.fromEntries(allLoadedTabs().map((tab) => [tab.id, { cursorLine: tab.cursorLine, cursorColumn: tab.cursorColumn }]));
    writeStorage(cursorStorageKey, serializeCursorPositions(positions));
  };
  const scheduleCursorPersistence = () => {
    if (cursorPersistTimer) window.clearTimeout(cursorPersistTimer);
    cursorPersistTimer = window.setTimeout(() => {
      cursorPersistTimer = undefined;
      persistCursorPositions();
    }, 250);
  };

  const persistRecovery = (tabId: string) => {
    const tab = tabById[tabId];
    if (!tab || !tab.dirty) {
      clearRecovery(tabId);
      return;
    }
    const recovery = compactRecoverySnapshot(createRecoverySnapshot(tab));
    const writeRevision = (recoveryWriteRevisions.get(tabId) ?? 0) + 1;
    recoveryWriteRevisions.set(tabId, writeRevision);
    if (!recovery || recoverySnapshotSizeBytes(recovery) > MAX_RECOVERY_BYTES) {
      if (!recoveryStorageWarningShown) {
        recoveryStorageWarningShown = true;
        notify("Recovery backup skipped for this large document; editing is still available.");
      }
      unavailableRecoveryKeys.add(recoveryKey(tabId));
      pendingRecoverySnapshots.delete(recoveryKey(tabId));
      scheduleSessionPersistence();
      return;
    }
    const key = recoveryKey(tabId);
    pendingRecoverySnapshots.set(key, recovery);
    pendingRecoveryRemovals.delete(key);
    unavailableRecoveryKeys.delete(key);
    scheduleSessionPersistence();
  };

  const clearRecovery = (tabId: string) => {
    recoveryScheduler.cancel(tabId);
    recoveryWriteRevisions.set(tabId, (recoveryWriteRevisions.get(tabId) ?? 0) + 1);
    const key = recoveryKey(tabId);
    pendingRecoverySnapshots.delete(key);
    unavailableRecoveryKeys.delete(key);
    pendingRecoveryRemovals.add(key);
    // The durable baseline record is dropped with the recovery entry; a later
    // edit must rewrite it even when the savedRevision is unchanged.
    checkpointedBaselines.delete(key);
    scheduleSessionPersistence();
  };

  const flushRecoveryWrites = async () => {
    if (sessionPersistTimer) {
      window.clearTimeout(sessionPersistTimer);
      sessionPersistTimer = undefined;
    }
    const committed = await commitCurrentCheckpoint();
    await flushSessionPersistence();
    return committed;
  };

  const writeRecoveryCheckpoint = (tabId: string) => {
    persistRecovery(tabId);
    void flushRecoveryWrites().catch((error) => emitDiagnostic("recovery.flush", error));
  };

  const scheduleRecovery = (tabId: string) => {
    const tab = tabById[tabId];
    if (!tab?.dirty) {
      clearRecovery(tabId);
      return;
    }
    if (document.visibilityState === "hidden" || !document.hasFocus()) {
      recoveryScheduler.cancel(tabId);
      writeRecoveryCheckpoint(tabId);
      return;
    }
    const sizeBytes = documentController.getHandle(tab.id)?.getMetadata()?.estimatedBytes ?? tab.estimatedBytes ?? tab.diskSize ?? 0;
    recoveryScheduler.schedule(tabId, sizeBytes, Date.now(), () => writeRecoveryCheckpoint(tabId));
  };

  const persistSettings = () => {
    settingsPersistTimer = undefined;
    if (!writeStorage("pude-settings-v1", JSON.stringify(settings())) && !sessionStorageWarningShown) {
      sessionStorageWarningShown = true;
      notify("Settings could not be saved.");
    }
  };

  const scheduleSettingsPersistence = () => {
    if (settingsPersistTimer) window.clearTimeout(settingsPersistTimer);
    settingsPersistTimer = window.setTimeout(persistSettings, 250);
  };

  function scheduleGitRefresh(nextState: GitDirtyState = { status: true, branches: false, history: false }) {
    gitDirtyState = mergeGitDirtyState(gitDirtyState, nextState);
    const now = Date.now();
    gitRefreshFirstPendingAt ??= now;
    if (gitRefreshTimer) window.clearTimeout(gitRefreshTimer);
    const delay = gitRefreshDelay(sidebarView() === "git", now, gitRefreshFirstPendingAt);
    gitRefreshTimer = window.setTimeout(() => {
      gitRefreshTimer = undefined;
      gitRefreshFirstPendingAt = undefined;
      void refreshGit(false);
    }, delay);
  }

  createEffect(() => {
    const currentSettings = settings();
    document.documentElement.dataset.theme = currentSettings.theme;
    scheduleSettingsPersistence();
    const nextExcludesKey = currentSettings.watcherExcludes.join("\u0000");
    const excludesChanged = watcherExcludesKey !== undefined && watcherExcludesKey !== nextExcludesKey;
    watcherExcludesKey = nextExcludesKey;
    if (excludesChanged && hydrated()) void restartWatcher();
  });

  createEffect(() => {
    const title = windowTitleForWorkspace(workspace(), PATH_OPTIONS);
    document.title = title;
    if (isTauri) void getWindowApi().then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch((error) => emitDiagnostic("window.failure", error));
  });

  createEffect(() => {
    const visible = sidebarView() === "git";
    const currentWorkspace = workspace();
    if (visible && currentWorkspace && hasGitDirtyState(gitDirtyState)) scheduleGitRefresh(gitDirtyState);
  });

  createEffect(() => {
    const currentPlugins = plugins();
    const persistedPlugins = currentPlugins
      .filter((plugin) => plugin.source === "local")
      .map((plugin) => ({ ...plugin, status: "inactive" as const }));
    if (!hydrated() && !persistedPlugins.length) return;
    if (!writeStorage(PLUGINS_STORAGE_KEY, JSON.stringify(persistedPlugins)) && !pluginStorageWarningShown) {
      pluginStorageWarningShown = true;
      notify("Installed plugin state could not be saved.");
    }
  });

  onMount(async () => {
    // Capture the startup generation before the first await. Any workspace
    // action that completes while storage or the first file is loading must
    // remain authoritative over this startup restore.
    const restoreGeneration = workspaceGeneration;
    setRecoveryDatabaseBlockedHandler((timeoutMs, status) => notify(status === "timed-out" ? "Recovery storage did not open in time. Close the other editor window and retry; existing recovery data has been retained." : `Another window is blocking recovery storage. Close the other editor window and retry; this attempt will stop within ${timeoutMs / 1000} seconds.`));
    let startupPluginRecoverySucceeded = !isTauri;
    // Fetch the close-window dialog chunk while the browser is idle so
    // closing the window never waits on a network fetch, without blocking the
    // first paint.
    preloadCloseWindowDialog();
    // The folder probe, plugin recovery, file-event listener and
    // session resolution are independent of each other; start them together
    // so plugin recovery and listener setup do not block session restore.
    const launchFolderPromise = getStartupFolder().then(
      (folder) => { markStartupEvent("startup-folder"); return folder; },
      () => null,
    );
    const pluginRecoveryPromise = (async () => {
      if (!isTauri) return;
      try {
        const previousPlugins = plugins();
        const recovery = await recoverPluginUpdates(previousPlugins.map((plugin) => plugin.id));
        if (disposed) return;
        const previousById = new Map(previousPlugins.map((plugin) => [plugin.id, plugin]));
        const reconciledPlugins = recovery.plugins.map((plugin) => {
          const previous = previousById.get(plugin.id);
          return {
            ...plugin,
            enabled: Boolean(previous?.enabled && previous.version === plugin.version),
            status: "inactive" as const,
          };
        });
        const persistedPlugins = reconciledPlugins.map((plugin) => ({ ...plugin, status: "inactive" as const }));
        if (!writeStorage(PLUGINS_STORAGE_KEY, JSON.stringify(persistedPlugins))) {
          setPlugins(reconciledPlugins.map((plugin) => ({ ...plugin, enabled: false })));
          notify("Recovered plugin state could not be saved; plugins remain disabled.");
        } else {
          setPlugins(reconciledPlugins);
          setPendingCleanupIds(recovery.pendingCleanupIds);
          startupPluginRecoverySucceeded = true;
        }
      } catch (error) {
        if (!disposed) notify(errorMessage(error, "Installed plugin state could not be recovered."));
      }
    })();
    // The native event stream is a per-session channel created
    // when the watcher starts, so there is no global listener to register
    // here. Begin buffering before session storage is read: any channel
    // created by the later startWatcher call feeds events into this buffer
    // while startup restores tabs.
    watcherEvents.clear();
    watcherEvents.beginBuffering();
    sessionWindowId = await resolveSessionScope();
    const startupSessionPromise: Promise<StartupSessionSelection> = resolveStartupSession(sessionWindowId).then(
      (selection) => selection,
      (error) => {
        notify(errorMessage(error, "Session restore state could not be read."));
        return { scope: sessionWindowId, checkpoint: null, legacy: null, lease: null, recoveredSecondary: false, recoveryUnavailable: true, startupError: error };
      },
    );
    const [launchFolder, startupSessionResolved, workspaceRuntime] = await Promise.all([launchFolderPromise, startupSessionPromise, loadProjectRuntime()]);
    projectRuntime = workspaceRuntime;
    let startupSession = startupSessionResolved;
    sessionStartupUnavailable = startupSession.recoveryUnavailable === true;
    if (Object.prototype.hasOwnProperty.call(startupSession, "startupError")) emitDiagnostic("session.failure", startupSession.startupError);
    if (startupSession.pendingReleaseLease) sessionLeaseReleaseQueue.retain(startupSession.pendingReleaseLease);
    if (disposed) {
      if (startupSession.lease) sessionLeaseReleaseQueue.retain(startupSession.lease);
      void sessionLeaseReleaseQueue.releaseAll();
      return;
    }
    if (restoreGeneration !== workspaceGeneration) {
      // Keep the stable scope chosen for this renderer, but discard the
      // superseded restore payload. The lease is retained solely so the
      // cleanup branch below can release a claim completed during the race.
      startupSession = { scope: sessionWindowId, checkpoint: null, legacy: null, lease: startupSession.lease, pendingReleaseLease: startupSession.pendingReleaseLease, recoveredSecondary: false };
    }
    sessionScope = startupSession.scope;
    sessionStorageKey = scopedStorageKey(SESSION_STORAGE_KEY, sessionScope);
    cursorStorageKey = scopedStorageKey(CURSOR_STORAGE_KEY, sessionScope);
    const checkpoint = startupSession.checkpoint;
    sessionRestoreCheckpointVerified = Boolean(checkpoint);
    markStartupEvent("session-read");
    let restored = !sessionStartupUnavailable && !startupSession.pendingReleaseLease && !launchFolder && restoreGeneration === workspaceGeneration
      ? checkpoint?.session ?? startupSession.legacy
      : null;
    if (restored && (restored.workspace || restored.tabs.length || restored.projects?.length)) {
      const savedProjects = restored.projects ?? [{ id: crypto.randomUUID(), workspace: restored.workspace, tabs: restored.tabs, activeTabId: restored.activeTabId, expandedPaths: restored.expandedPaths }];
      const states = savedProjects.map((saved) => ({ ...createProject(saved.workspace, saved.id),
        restoreMetadata: { version: 3 as const, workspace: saved.workspace, tabs: saved.tabs, activeTabId: saved.activeTabId, expandedPaths: saved.expandedPaths },
        restoreIntent: createRestoreIntent(saved.tabs, restoreGeneration) }));
      const selected = states.find((project) => project.id === restored!.activeProjectId) ?? states[0];
      setProjects(states);
      setActiveProjectId(selected?.id);
      restored = selected?.restoreMetadata ?? null;
    }
    if (restored?.workspace && restored.workspace !== "pude-demo") {
      try {
        const canonicalWorkspace = await canonicalizeWorkspaceRoot(restored.workspace);
        restored = { ...restored, workspace: canonicalWorkspace };
      } catch (error) {
        notify(errorMessage(error, "The restored workspace could not be verified."));
        // Keep the original root and recovery when a restored folder is unavailable.
      }
    }
    const checkpointRecoveries = checkpoint?.recoveries;
    restoredCheckpointRecoveries = checkpointRecoveries;
    if (checkpointRecoveries) {
      // A baseline restored with the checkpoint is already durable;
      // do not rewrite its record on the first commit after startup.
      for (const [key, snapshot] of Object.entries(checkpointRecoveries)) {
        if (snapshot.savedRevision !== undefined && !snapshot.savedContentUnavailable) checkpointedBaselines.set(key, snapshot.savedRevision);
      }
    }
    restoreMetadata = restored ?? undefined;
    if (restored?.tabs.length) {
      // Start downloading/compiling the editor chunk and the active
      // tab's language support in parallel with the IPC reads below.
      void getEditorChunk();
      const firstRestoredTab = restored.tabs.find((tab) => tab.id === restored.activeTabId) ?? restored.tabs[0];
      if (firstRestoredTab && !isImagePath(firstRestoredTab.path)) {
        const metadata = fileLanguageForPath(firstRestoredTab.path);
        if (metadata.key && (firstRestoredTab.diskSize ?? 0) < 5 * 1024 * 1024) {
          void import("./lib/editor-languages")
            .then(({ loadEditorLanguageSupport }) => loadEditorLanguageSupport(metadata))
            .catch(() => undefined);
        }
      }
    }
    if (restored) {
      restoreIntent = createRestoreIntent(restored.tabs, restoreGeneration);
      // A user can open a file while the startup checkpoint is being read,
      // before RestoreIntent exists. Seed those paths so the pending restore
      // cannot add a duplicate tab later.
      for (const tab of tabs()) markUserOpenedRestorePath(tab.path);
    } else {
      restoreIntent = undefined;
    }
    const adoptStartupLease = async (lease: SessionWindowLease, generation: number) => {
      if (checkpoint && !await validateStartupCheckpoint(checkpoint, lease)) {
        pauseUnverifiedSessionRecovery();
        await sessionLeaseReleaseQueue.release(lease);
      } else if (!disposed && generation === workspaceGeneration && restoreGeneration === workspaceGeneration) {
        sessionLease = lease;
        unblockSessionPersistence();
      } else await sessionLeaseReleaseQueue.release(lease);
    };
    try {
      if (sessionStartupUnavailable) {
        pauseUnverifiedSessionRecovery();
        if (startupSession.lease) sessionLeaseReleaseQueue.retain(startupSession.lease);
        await sessionLeaseReleaseQueue.releaseAll();
      } else if (restoreGeneration !== workspaceGeneration) {
        // A secondary recovery claim may have completed after the user
        // switched workspaces during startup. Release that claim instead of
        // attaching a lease for a restore that is no longer current.
        if (startupSession.lease) {
          await sessionLeaseReleaseQueue.release(startupSession.lease);
        }
      } else if (sessionLeaseReleaseQueue.hasPending() && !await sessionLeaseReleaseQueue.releaseAll()) {
        blockSessionPersistence("A previous session lease still needs cleanup; unsaved recovery remains paused.");
      } else if (startupSession.lease) {
        await adoptStartupLease(startupSession.lease, restoreGeneration);
      } else {
        const attachGeneration = workspaceGeneration;
        const attached = await attachSessionWindow({
          windowId: sessionWindowId,
          scope: sessionScope,
          workspace: restored?.workspace ?? "",
          dirtyRecoveryKeys: checkpoint?.session.tabs.filter((tab) => tab.dirty).map((tab) => recoveryStorageKey(tab.id, sessionScope)),
        });
        if (attached.ok && attached.lease) {
          await adoptStartupLease(attached.lease, attachGeneration);
        }
        else if (attachGeneration === workspaceGeneration) {
          sessionLeaseWarningShown = true;
          blockSessionPersistence(attached.reason === "conflict"
            ? "This session scope is already owned by another window; unsaved recovery is paused."
            : "Session recovery storage is unavailable; unsaved recovery cannot be protected.");
        }
      }
    } catch (error) {
      sessionLeaseWarningShown = true;
      blockSessionPersistence(errorMessage(error, "Session recovery storage is unavailable; unsaved recovery cannot be protected."));
    }
    sessionHeartbeatTimer = window.setInterval(() => {
      const lease = sessionLease;
      if (!lease || disposed) return;
      void heartbeatSessionWindow(lease, windowSession().tabs.filter((tab) => tab.dirty).map((tab) => recoveryStorageKey(tab.id, sessionScope))).then((result) => {
        if (sessionLease !== lease || result.ok) return;
        sessionLeaseWarningShown = true;
        blockSessionPersistence("Session window ownership was lost; unsaved recovery is paused until it is restored.");
      }).catch((error) => {
        if (sessionLease !== lease) return;
        sessionLeaseWarningShown = true;
        blockSessionPersistence(errorMessage(error, "Session window ownership was lost; unsaved recovery is paused until it is restored."));
      });
    }, 60_000);
    const initialWorkspace = restored && restored.workspace !== "pude-demo" ? restored.workspace : "";
    if (initialWorkspace) {
      setWorkspace(initialWorkspace);
      if (authorizationManager || plugins().some((plugin) => plugin.enabled)) {
        void ensureAuthorizationManager().then((manager) => {
          if (!disposed && restoreGeneration === workspaceGeneration) manager.notifyWorkspaceChanged("", initialWorkspace);
        });
      }
      setRoot({ name: baseName(initialWorkspace), path: initialWorkspace, kind: "directory", expanded: true, loaded: false });
      if (isTauri) {
        const restoredOpenFiles = restored?.tabs.map((tab) => tab.path) ?? [];
        const restoredExternalParents = restoredOpenFiles
          .filter((path) => !isSameOrDescendantPath(path, initialWorkspace))
          .map(parentPath);
        externalWatchParents.clear();
        restoredExternalParents.forEach((path) => externalWatchParents.add(path));
        watcherOpenFilesKey = restoredOpenFiles.map(pathKey).sort().join("\u0000");
        // Don't make the first tab wait for the watcher. The listener
        // is already buffering events; once the watcher reports ready,
        // verifyOpenFiles() covers changes made between the initial reads and
        // the watch registration (same pattern as the non-restore path).
        void (async () => {
          try {
            const nextSessionId = await enqueueWatcherOperation(async () => {
              watcherEvents.resetSequence();
              return startWatcher(initialWorkspace, [...externalWatchParents], settings().watcherExcludes, restoredOpenFiles, handleFileChangeEvent);
            });
            if (!disposed && restoreGeneration === workspaceGeneration) {
              watcherSessionId = nextSessionId;
              watcherNeedsRestart = false;
              if (!startupWatcherReadyMarked) {
                startupWatcherReadyMarked = true;
                markStartupEvent("watcher-ready");
              }
              verifyOpenFiles();
            } else if (nextSessionId) {
              await stopWatcher(nextSessionId);
            }
          } catch (error) {
            watcherNeedsRestart = true;
            if (!disposed) notify(errorMessage(error, "Unable to start file watcher."));
            scheduleWatcherRetry(restoreGeneration);
          }
        })();
      }
    }
    if (restored && restored.workspace !== "pude-demo") {
      const cursorPositions = startupSession.cursorPositions ?? {};
      const restoreScope = sessionScope;
      const isRestoreCurrent = () => !disposed
        && !sessionStartupUnavailable
        && restoreGeneration === workspaceGeneration
        && sessionScope === restoreScope;
      const readRestoreDocument = (path: string): Promise<ReadFileResult> => isRestoreCurrent()
        ? readFileWithIoLimit(path)
        : Promise.reject(new Error("Session restore was superseded."));
      const restoreOrder = restored.activeTabId
        ? [
            ...restored.tabs.filter((tab) => tab.id === restored.activeTabId),
            ...restored.tabs.filter((tab) => tab.id !== restored.activeTabId),
          ]
        : restored.tabs;
      const firstPersistedTab = restoreOrder.slice(0, 1);
      const acceptRestoredRecords = (records: Array<RestoredTabResult | null>) => records.filter((record): record is RestoredTabRecord => {
        if (!record) return false;
        if (!("status" in record)) return true;
        if (isRestoreCurrent()) {
          if (record.recoveryUnavailable) pauseUnverifiedSessionRecovery();
          else notify(`Unable to restore ${baseName(record.path)}. Its recovery metadata has been retained for retry.`);
          emitDiagnostic("session.failure", record.error);
        }
        return false;
      });
      const firstRecords = acceptRestoredRecords(await mapRestoreWithConcurrency(firstPersistedTab, 1, (persistedTab) => restorePersistedTab(persistedTab, cursorPositions[persistedTab.id], restoreScope, checkpointRecoveries, readRestoreDocument, isRestoreCurrent)));
      if (firstRecords.length && isRestoreCurrent() && !startupFirstTabReadyMarked) {
        startupFirstTabReadyMarked = true;
        markStartupEvent("first-tab-ready");
      }
      if (isRestoreCurrent()) {
        for (const record of firstRecords) {
          if (restoreIntent) restoreIntent = markRestoreTabStarted(restoreIntent, record.tab.id);
        }
        const currentTabs = tabs();
        const currentById = new Map(currentTabs.map((tab) => [tab.id, tab]));
        const currentIds = new Set(currentTabs.map((tab) => tab.id));
        const restoredById = new Map(firstRecords.map((record) => [record.tab.id, record]));
        // Startup reads are asynchronous. Preserve anything the user opened
        // while the active tab was loading, and let RestoreIntent suppress a
        // tab that was closed or whose path was opened by the user.
        const restoredTabs = restored.tabs.flatMap((persistedTab) => {
          const current = currentById.get(persistedTab.id);
          if (current) return [current];
          const record = restoredById.get(persistedTab.id);
          if (!record || currentTabs.some((tab) => samePath(tab.path, persistedTab.path)) || !restoreIntent || !shouldMergeRestoredTab(restoreIntent, persistedTab, currentIds)) return [];
          return [{ ...record.tab, ...(record.orphaned ? { orphaned: true } : {}) }];
        });
        const restoredIds = new Set(restoredTabs.map((tab) => tab.id));
        setWorkspace(restored.workspace);
        setTabs([...restoredTabs, ...currentTabs.filter((tab) => !restoredIds.has(tab.id))]);
        syncExternalWatchParents();
        const currentActiveTabId = activeTabId();
        if (!currentActiveTabId && restored.activeTabId && restoredTabs.some((tab) => tab.id === restored.activeTabId)) setActiveTab(restored.activeTabId);
        const restoredRecordIds = new Set(restoredTabs.map((tab) => tab.id));
        const recoveredConflict = firstRecords.find((record) => restoredRecordIds.has(record.tab.id) && record.diskChangedSinceRecovery)?.tab;
        if (recoveredConflict) externalConflictController.queue(recoveredConflict);
        if (restored.workspace) {
          const workspacePath = restored.workspace;
          const restoredRoot: DirectoryEntry = { name: baseName(workspacePath), path: workspacePath, kind: "directory", expanded: true, loaded: false };
          setRoot(restoredRoot);
          void (async () => {
            try {
              await watcherOperationQueue;
              const snapshot = watcherEvents.snapshot();
              const isWorkspaceRestoreCurrent = () => !disposed && !sessionStartupUnavailable
                && restoreGeneration === workspaceGeneration && sessionScope === restoreScope
                && workspace() === workspacePath && watcherEvents.isCurrent(snapshot);
              const listing = await listWorkspaceDirectory(workspacePath);
              const expandedPaths = new Set(restored.expandedPaths.map(pathKey));
              expandedPaths.add(pathKey(workspacePath));
              await restoreDirectoryTreeByLevelLazy({
                root: { ...restoredRoot, children: listing.entries, loaded: true, partialError: listing.partialError ?? undefined, incomplete: listing.incomplete, listingStopReason: listing.stopReason },
                expandedPaths,
                listDirectory: listWorkspaceDirectory,
                isCurrent: isWorkspaceRestoreCurrent,
                onTree: (tree) => {
                  if (isWorkspaceRestoreCurrent()) setRoot(tree);
                },
              });
              if (isWorkspaceRestoreCurrent()) markSessionDirty();
            } catch (error) {
              if (!disposed && !sessionStartupUnavailable && restoreGeneration === workspaceGeneration
                && sessionScope === restoreScope && workspace() === workspacePath) {
                const message = errorMessage(error, "Unable to restore workspace directories.");
                setRoot((current) => ({ ...current, partialError: { kind: "metadata", message } }));
                notify(message);
              }
            }
          })();
          void refreshGit(false, workspacePath);
        } else {
          setGit(emptyGit);
        }
      }
      const remainingPersistedTabs = restoreOrder.slice(firstPersistedTab.length);
      if (remainingPersistedTabs.length) {
        void mapRestoreWithConcurrency(remainingPersistedTabs, 8, (persistedTab) => restorePersistedTab(persistedTab, cursorPositions[persistedTab.id], restoreScope, checkpointRecoveries, readRestoreDocument, isRestoreCurrent)).then((results) => {
          if (!isRestoreCurrent()) return;
          const records = acceptRestoredRecords(results);
          const currentTabs = tabs();
          const currentById = new Map(currentTabs.map((tab) => [tab.id, tab]));
          const restoredById = new Map(records.map((record) => [record.tab.id, record]));
          for (const record of records) {
            if (restoreIntent) restoreIntent = markRestoreTabStarted(restoreIntent, record.tab.id);
          }
          const currentIds = new Set(currentTabs.map((tab) => tab.id));
          const restoredTabs = restored.tabs.flatMap((persistedTab) => {
            const current = currentById.get(persistedTab.id);
            if (current) return [current];
            const record = restoredById.get(persistedTab.id);
            if (!record || currentTabs.some((tab) => samePath(tab.path, persistedTab.path)) || !restoreIntent || !shouldMergeRestoredTab(restoreIntent, persistedTab, currentIds)) return [];
            return [{ ...record.tab, ...(record.orphaned ? { orphaned: true } : {}) }];
          });
          const restoredIds = new Set(restored.tabs.map((tab) => tab.id));
          setTabs([...restoredTabs, ...currentTabs.filter((tab) => !restoredIds.has(tab.id))]);
          for (const record of records) {
            if (record.diskChangedSinceRecovery) externalConflictController.queue(record.tab);
          }
          syncExternalWatchParents();
          verifyOpenFiles();
          markSessionDirty();
        }).catch(() => undefined);
      }
    } else if (!disposed && restoreGeneration === workspaceGeneration) {
      // Keep tabs opened while the startup checkpoint was loading. Only
      // initialise the recent-project surface when there is no user state to
      // preserve.
      if (!tabs().length) {
        setWorkspace("");
        setRoot(makeRecentProjectsRoot(recentProjects()));
        setActiveTab(undefined);
      }
      setGit(emptyGit);
    }
    setHydrated(true);
    void forgetMissingRecentProjects();
    if (isTauri && import.meta.env.PROD && settings().checkForUpdates) {
      window.setTimeout(() => { if (!disposed) void checkForUpdatesAfterStartup(); }, 5000);
    }
    markStartupEvent("hydrated");
    if (launchFolder) void openWorkspacePath(launchFolder);
    fileEventHandler = (event) => {
      // SB-04: events are directed to their owner window. Never adopt a
      // foreign watcher session; mismatched events are dropped. Events that
      // arrive during a watcher restart gap are buffered upstream by
      // watcherEvents and flushed once the new session is confirmed.
      if (event.sessionId && event.sessionId !== watcherSessionId) return;
      if (event.watchRoots?.length) watcherRoots = event.watchRoots;
      if (event.error) {
        watcherNeedsRestart = true;
        notify(`File watcher needs attention: ${event.error}`);
        void restartWatcher();
      }

      const changes: FileChange[] = event.changes?.length
        ? event.changes
        : event.paths.map((path) => ({ kind: "modify" as const, path }));
      for (const change of changes) {
        versionedFileReader?.invalidate(change.path);
        if (change.oldPath) versionedFileReader?.invalidate(change.oldPath);
      }
      if (event.needsRescan) for (const tab of tabs()) versionedFileReader?.invalidate(tab.path);
      const currentWorkspace = workspace();
      const repositoryRoot = git().repositoryRoot;
      const metadataPaths = changes.flatMap((change) => [change.path, change.oldPath]).filter((path): path is string => Boolean(path));
      const repositoryChanged = Boolean(repositoryRoot && metadataPaths.some((path) => isSameOrDescendantPath(path, repositoryRoot)));
      const gitDirty = event.needsRescan && repositoryRoot ? allGitDirtyState() : classifyGitChanges(changes, repositoryRoot, watcherRoots);
      gitDirtyState = mergeGitDirtyState(gitDirtyState, gitDirty);
      if (gitDirty.status) gitStatusRevision += 1;
      if (gitDirty.branches || gitDirty.history || event.needsRescan) {
        gitBranchesDirty = true;
        gitBranchesRevision += 1;
        invalidateGitHistory();
      }
      if (gitDirty.status || gitDirty.branches || gitDirty.history) scheduleGitRefresh(gitDirty);
      const reloadPaths = new Set<string>();
      for (const change of changes) {
        const parent = parentPath(change.path);
        const affectsDirectoryListing = change.isDirectory || change.kind === "create" || change.kind === "remove" || change.kind === "rename";
        if (affectsDirectoryListing) scheduleDirectoryRefresh(parent);
        if (change.isDirectory) scheduleDirectoryRefresh(change.path);
        if (change.oldPath && affectsDirectoryListing) scheduleDirectoryRefresh(parentPath(change.oldPath));
        if (change.kind === "rename" && change.oldPath) renameOpenTabs(change.oldPath, change.path);
        if (change.kind === "rename" && !change.oldPath && !change.isDirectory) reloadPaths.add(change.path);
        if (change.kind === "remove") {
          const removedTabs = tabs().filter((tab) => isSameOrDescendantPath(tab.path, change.path));
          for (const tab of removedTabs) {
            if (tab.language !== "Image") reloadPaths.add(tab.path);
            else updateTab(tab.id, { orphaned: true });
          }
        }
        if (!change.isDirectory && (change.kind === "create" || change.kind === "modify" || change.kind === "rescan")) reloadPaths.add(change.path);
      }
      if (event.needsRescan) relistAllDirectories();

      if (event.needsRescan) {
        for (const tab of tabs()) reloadPaths.add(tab.path);
      }
      const candidates = tabs().filter((tab) => tab.language !== "Image" && [...reloadPaths].some((path) => samePath(path, tab.path)));
      for (const tab of candidates) {
        const readRevision = (fileReadRevisions.get(tab.id) ?? 0) + 1;
        fileReadRevisions.set(tab.id, readRevision);
        const generation = workspaceGeneration;
        verifyOpenFile(tab, generation, readRevision);
      }
      if (repositoryChanged && !gitDirty.status && !gitDirty.branches && !gitDirty.history) scheduleGitRefresh({ status: true, branches: false, history: false });
      const currentDiff = diff();
      const affectedWorkingDiff = currentDiff && (currentDiff.label === "STAGED CHANGES" || currentDiff.label === "WORKING TREE")
        && changes.some((change) => sameGitPath(change.path, currentDiff.path, repositoryRoot) || Boolean(change.oldPath && sameGitPath(change.oldPath, currentDiff.path, repositoryRoot)));
      if (affectedWorkingDiff) {
        void openDiff({ path: currentDiff.path, indexStatus: null, worktreeStatus: null }, currentDiff.staged);
      }
    };
    if (isTauri) await watcherOperationQueue;
    if ((workspace() || externalWatchParents.size) && !watcherSessionId && isTauri) {
      try {
        const currentWorkspace = workspace();
        const generation = workspaceGeneration;
        const nextSessionId = await enqueueWatcherOperation(async () => {
          watcherEvents.resetSequence();
          return startWatcher(currentWorkspace, [...externalWatchParents], settings().watcherExcludes, tabs().filter((tab) => tab.language !== "Image").map((tab) => tab.path), handleFileChangeEvent);
        });
        if (disposed || generation !== workspaceGeneration || workspace() !== currentWorkspace) {
          if (nextSessionId) await stopWatcher(nextSessionId);
          return;
        }
        watcherSessionId = nextSessionId;
        watcherNeedsRestart = false;
        if (!startupWatcherReadyMarked) {
          startupWatcherReadyMarked = true;
          markStartupEvent("watcher-ready");
        }
        lastFileEventSequence = 0;
        watcherRetryAttempt = 0;
        verifyOpenFiles();
        scheduleGitRefresh(allGitDirtyState());
      } catch (error) {
        watcherNeedsRestart = true;
        if (!disposed) {
          notify(errorMessage(error, "Unable to start file watcher."));
          scheduleWatcherRetry(workspaceGeneration);
        }
      }
    }
    if (!disposed) flushBufferedWatcherEvents();
    await pluginRecoveryPromise;
    if (disposed) return;
    const pluginStartupGeneration = workspaceGeneration;
    let pluginsSafeToActivate = startupPluginRecoverySucceeded;
    if (isTauri && pluginsSafeToActivate && workspace()) {
      const workspaceRoot = workspace();
      // Restore per-plugin LSP approvals in parallel after the first
      // tab is already on screen; a failing plugin is disabled exactly as
      // before.
      const enabledPlugins = plugins().filter((item) => item.enabled);
      const lspRestoreResults = await Promise.allSettled(
        enabledPlugins.map((plugin) => restorePluginLspAuthorizations(plugin, workspaceRoot)),
      );
      if (disposed) return;
      const approvalsCurrent = pluginStartupGeneration === workspaceGeneration && workspaceRoot === workspace();
      const pluginsWithUnavailableLsp = new Set<string>();
      lspRestoreResults.forEach((result, index) => {
        if (!approvalsCurrent) return;
        if (result.status === "rejected") {
          const plugin = enabledPlugins[index];
          pluginsWithUnavailableLsp.add(plugin.id);
          notify(errorMessage(result.reason, `${plugin.name}: language-server approvals could not be restored; the plugin was disabled.`));
        }
      });
      if (pluginsWithUnavailableLsp.size) {
        const disabledPlugins = plugins().map((plugin) => pluginsWithUnavailableLsp.has(plugin.id)
          ? { ...plugin, enabled: false, status: "inactive" as const }
          : plugin);
        const persistedPlugins = disabledPlugins.map((plugin) => ({ ...plugin, status: "inactive" as const }));
        setPlugins(disabledPlugins);
        if (!writeStorage(PLUGINS_STORAGE_KEY, JSON.stringify(persistedPlugins))) {
          pluginsSafeToActivate = false;
          notify("Disabled plugin state could not be saved; plugins remain unavailable for this session.");
        }
      }
    }
    if (isTauri) setPluginsRecovered(pluginsSafeToActivate);
    if (!disposed && workspace()) activatePluginsForEvent("onWorkspaceOpen", { workspace: workspace() });
  });

  onCleanup(() => {
    disposed = true;
    setRecoveryDatabaseBlockedHandler(undefined);
    clearWatcherRetry();
    watcherEvents.clear();
    watcherSessionId = undefined;
    void enqueueWatcherOperation(() => stopWatcher().then(() => undefined)).catch((error) => emitDiagnostic("watcher.cancel", error));
    const closingWorkspace = workspace();
    if (closingWorkspace) void cancelWorkspaceOperations(closingWorkspace).catch((error) => emitDiagnostic("window.cancel", error));
    if (sessionHeartbeatTimer) {
      window.clearInterval(sessionHeartbeatTimer);
      sessionHeartbeatTimer = undefined;
    }
    if (toastTimer) window.clearTimeout(toastTimer);
    if (cursorPersistTimer) {
      window.clearTimeout(cursorPersistTimer);
      cursorPersistTimer = undefined;
      persistCursorPositions();
    }
    if (sessionPersistTimer) {
      window.clearTimeout(sessionPersistTimer);
      sessionPersistTimer = undefined;
    }
    if (settingsPersistTimer) {
      window.clearTimeout(settingsPersistTimer);
      settingsPersistTimer = undefined;
      persistSettings();
    }
    recoveryScheduler.flush((tabId) => persistRecovery(tabId));
    const lease = sessionLease;
    void flushRecoveryWrites().then(() => {
      if (!lease) return;
      return sessionLeaseReleaseQueue.release(lease).then((released) => {
        // Cleanup can race a hot-replaced renderer that already owns a fresh lease.
        // Explicit close requests handle a failed close before allowing the window to exit.
        if (!released) return;
        if (sessionLease === lease) sessionLease = undefined;
      });
    }).catch((error) => emitDiagnostic("session.flush", error));
    void sessionLeaseReleaseQueue.releaseAll();
    if (gitRefreshTimer) window.clearTimeout(gitRefreshTimer);
    cancelWorkspaceReads();
    disposeDirectoryRefresh();
    gitHistoryController?.dispose();
    versionedFileReader?.dispose();
    workspaceIo.dispose();
    externalWatchParents.clear();
    fileReadRevisions.clear();
    externalConflictController.dispose();
    documentController.dispose();
    if (documentCacheTimer !== undefined) window.clearTimeout(documentCacheTimer);
    invalidateAllPluginRuns();
    stopSidebarResize();
  });

  onMount(() => {
    if (!isTauri) return;
    void getWindowApi().then(({ getCurrentWindow }) => {
      if (disposed) return;
      const currentWindow = getCurrentWindow();
      void currentWindow.isMaximized().then(setWindowMaximized);
      let unlistenResize: (() => void) | undefined;
      let unlistenClose: (() => void) | undefined;
      void currentWindow.onResized(() => void currentWindow.isMaximized().then(setWindowMaximized)).then((unlisten) => { unlistenResize = unlisten; });
      void currentWindow.onCloseRequested((event) => {
        event.preventDefault();
        void closeWindow("preserve");
      }).then((unlisten) => { unlistenClose = unlisten; });
      onCleanup(() => {
        unlistenResize?.();
        unlistenClose?.();
      });
    }).catch((error) => emitDiagnostic("window.failure", error));
  });

  const canSwitchProject = () => {
    if (!hydrated() || confirmedOperationInProgress() || appQuitPrepared() || dialogRequestInFlight || projectCloseBusy() || projectCloseId()) return false;
    if (pluginOperationInFlight || gitMutationInFlight) {
      notify("Wait for the current project operation to finish before switching projects.");
      return false;
    }
    return true;
  };

  const installProjectState = (project: ProjectWorkspaceState) => {
    batch(() => {
      restoreMetadata = project.restoreMetadata;
      restoreIntent = project.restoreIntent ? { ...project.restoreIntent, generation: workspaceGeneration } : undefined;
      setActiveProjectId(project.id || undefined);
      setWorkspace(project.workspace);
      setRoot(project.root);
      setTabOrder([...project.tabIds]);
      setActiveTab(project.activeTabId);
      setViewMode(project.viewMode);
      setHistoryTabOpen(project.historyTabOpen);
      setDiffReturnToHistory(project.diffReturnToHistory);
      setDiff(project.diff);
      setGit(project.git);
      setGitBranches(project.gitBranches);
      setSidebarView(project.sidebarView);
      setSearch(project.search);
      setSearchOpen(project.searchOpen);
      setReplaceOpen(project.replaceOpen);
      setSearchActionTargetTabId(undefined);
      setGoToLine(undefined);
      setMarkdownPreviewEnabled(project.markdownPreviewEnabled ?? false);
      setGitIgnoredExpanded(project.gitIgnoredExpanded ?? false);
      setGitIgnoredPaths(new Set<string>());
      setLastClosedTab(project.lastClosedTab);
      setTerminalOpen(project.terminalOpen);
      setTerminalInitialized(project.terminalInitialized);
      setExternalConflicts(project.conflicts);
      setTabMenu(undefined);
      setFileMenu(undefined);
    });
  };

  const restoreSelectedProjectDocuments = async () => {
    const generation = workspaceGeneration;
    const id = activeProjectId();
    await projectRuntime!.restoreProjectDocuments({
      session: restoreMetadata, intent: restoreIntent, scope: sessionScope, recoveries: restoredCheckpointRecoveries,
      isCurrent: () => !disposed && generation === workspaceGeneration && id === activeProjectId(),
      readDocument: readFileWithIoLimit, normalizeReadFile, createImageTab: makeImageTab, getTabs: tabs, getIntent: () => restoreIntent,
      onTabs: setTabs, onIntent: (intent) => { restoreIntent = intent; }, onConflict: (tab) => externalConflictController.queue(tab),
      onFailure: (failure) => {
        if (failure.recoveryUnavailable) pauseUnverifiedSessionRecovery();
        notify(`Unable to restore ${baseName(failure.path)}. Its recovery metadata has been retained for retry.`);
      },
    });
    if (generation !== workspaceGeneration) return;
    if (!activeTabId()) setActiveTab(tabs().find((tab) => tab.id === restoreMetadata?.activeTabId)?.id ?? tabs()[0]?.id);
    syncExternalWatchParents();
    markSessionDirty();
  };

  const transitionToProject = async (target: ProjectWorkspaceState, add = false): Promise<boolean> => {
    let previous = activeProjectId() ? captureProject() : createProject("", "");
    let installed = false;
    const generation = ++workspaceGeneration;
    cancelWorkspaceReads(true);
    watcherRestartVersion += 1;
    clearWatcherRetry();
    watcherEvents.clear();
    watcherEvents.beginBuffering();
    invalidateAllPluginRuns();
    resetGitHistoryPagination();
    fileReadRevisions.clear();
    try {
      if (previous.workspace) {
        await cancelWorkspaceOperations(previous.workspace);
        await stopWorkspaceLsp(previous.workspace);
        await Promise.all(plugins().map((plugin) => revokePluginNetwork(plugin.id, previous.workspace)));
      }
      await enqueueWatcherOperation(() => stopWatcher());
      if (disposed || generation !== workspaceGeneration) return false;
      watcherSessionId = undefined;
      watcherRestarting = false;
      watcherRoots = [];
      watcherOpenFilesKey = undefined;
      externalWatchParents.clear();
      batch(() => {
        // The editor stays interactive while the old project shuts down, so park its latest state.
        if (activeProjectId()) previous = captureProject();
        setProjects((items) => {
          const parked = items.map((project) => project.id === previous.id ? previous : project);
          return add ? [...parked, target] : parked;
        });
        installProjectState(target);
      });
      installed = true;
      setPlugins((items) => items.map((plugin) => plugin.status === "active" ? { ...plugin, status: "inactive" } : plugin));
      gitStatusRevision += 1;
      gitBranchesRevision += 1;
      gitDirtyState = allGitDirtyState();
      gitBranchesWorkspace = undefined;
      gitBranchesDirty = true;
      gitRequestVersion += 1;
      diffRequestVersion += 1;
      await reattachSessionWindow(target.workspace);
      await restoreSelectedProjectDocuments();
      if (target.workspace) {
        try {
          const listing = await listWorkspaceDirectory(target.workspace);
          if (generation !== workspaceGeneration || disposed) return false;
          const expanded = new Set((target.restoreMetadata?.expandedPaths ?? collectExpandedPaths(target.root)).map(pathKey));
          expanded.add(pathKey(target.workspace));
          await restoreDirectoryTreeByLevelLazy({
            root: { ...target.root, loaded: true, stale: false, children: mergeDirectoryState(target.root.children, listing.entries), partialError: listing.partialError ?? undefined, incomplete: listing.incomplete, listingStopReason: listing.stopReason },
            expandedPaths: expanded, listDirectory: listWorkspaceDirectory,
            isCurrent: () => !disposed && generation === workspaceGeneration,
            onTree: setRoot,
          });
        } catch (error) {
          setRoot((current) => ({ ...current, partialError: { kind: "metadata", message: errorMessage(error, "Project folder is unavailable.") } }));
          notify(errorMessage(error, "Project folder is unavailable; recovered files have been retained."));
        }
        syncExternalWatchParents();
        await restartWatcher();
        void refreshGit(false, target.workspace);
        if (authorizationManager || plugins().some((plugin) => plugin.enabled)) {
          (await ensureAuthorizationManager()).notifyWorkspaceChanged(previous.workspace, target.workspace);
          for (const plugin of plugins().filter((item) => item.enabled)) {
            try { await restorePluginLspAuthorizations(plugin, target.workspace); }
            catch (error) { notify(errorMessage(error, `${plugin.name}: language-server approvals could not be restored.`)); }
          }
        }
        activatePluginsForEvent("onWorkspaceOpen", { workspace: target.workspace });
      }
      verifyOpenFiles();
      markSessionDirty();
      scheduleDocumentCacheBudget();
      return true;
    } catch (error) {
      if (generation === workspaceGeneration && !disposed) {
        if (installed) {
          // Fence the target's in-flight reads, tree restore and git refresh before rolling back.
          ++workspaceGeneration;
          cancelWorkspaceReads(true);
          const attempted = captureProject();
          batch(() => {
            setProjects((items) => add && !attempted.tabIds.length
              ? items.filter((project) => project.id !== target.id)
              : items.map((project) => project.id === target.id ? attempted : project));
            installProjectState(previous);
          });
          await reattachSessionWindow(previous.workspace);
        }
        if (workspace()) { syncExternalWatchParents(); void restartWatcher(); }
      }
      notify(errorMessage(error, "Unable to switch project."));
      return false;
    }
  };

  const selectProject = async (id: string) => {
    if (id === activeProjectId() || !canSwitchProject()) return;
    const target = projects().find((project) => project.id === id);
    if (!target) return;
    setConfirmedOperationInProgress(true);
    try {
      if (authorizationReview()) await cancelPluginAuthorizationReview();
      await transitionToProject(target);
    } finally { setConfirmedOperationInProgress(false); }
  };

  const openWorkspacePath = async (selectedPath: string) => {
    if (!canSwitchProject()) return;
    setConfirmedOperationInProgress(true);
    try {
      if (authorizationReview()) await cancelPluginAuthorizationReview();
      const selected = await canonicalizeWorkspaceRoot(selectedPath);
      const existing = projects().find((project) => samePath(project.workspace, selected));
      const blankProjectId = activeProjectIsBlank() ? activeProjectId() : undefined;
      const discardBlankProject = () => {
        if (blankProjectId) setProjects((items) => items.filter((item) => item.id !== blankProjectId));
      };
      if (existing) {
        if (existing.id !== activeProjectId() && await transitionToProject(existing)) discardBlankProject();
        return;
      }
      const listing = await listWorkspaceDirectory(selected);
      const project = createProject(selected);
      project.root = { ...project.root, loaded: true, children: listing.entries, partialError: listing.partialError ?? undefined, incomplete: listing.incomplete, listingStopReason: listing.stopReason };
      if (await transitionToProject(project, true)) {
        if (blankProjectId) setProjects((items) => reorderProjects(items, project.id, blankProjectId));
        discardBlankProject();
        rememberRecentProject(selected);
        notify(`Opened ${baseName(selected)}`);
      }
    } catch (error) { notify(errorMessage(error, "Unable to open project.")); }
    finally { setConfirmedOperationInProgress(false); }
  };

  const removeProject = async (id: string) => {
    const snapshots = currentProjects();
    const target = snapshots.find((project) => project.id === id);
    if (!target) return;
    const nextId = projectAfterClose(snapshots.map((project) => project.id), activeProjectId(), id);
    if (activeProjectId() === id) {
      const next = snapshots.find((project) => project.id === nextId) ?? createProject("", "");
      if (!await transitionToProject(next)) return;
    }
    for (const tab of projectSession(target).tabs) {
      clearRecovery(tab.id);
      setTabById(tab.id, undefined!);
      documentController.release(tab.id);
    }
    setProjects((items) => items.filter((project) => project.id !== id));
    markSessionDirty();
  };

  const requestCloseProject = async (id: string) => {
    if (!canSwitchProject() || projectCloseId()) return;
    const target = currentProjects().find((project) => project.id === id);
    if (!target) return;
    if (projectSession(target).tabs.some((tab) => tab.dirty)) { setProjectCloseId(id); return; }
    setConfirmedOperationInProgress(true);
    try { await removeProject(id); }
    finally { setConfirmedOperationInProgress(false); }
  };

  const closeProjectWithDecision = async (decision: "save" | "discard") => {
    const id = projectCloseId();
    if (!id || projectCloseBusy()) return;
    setProjectCloseBusy(true);
    setConfirmedOperationInProgress(true);
    try {
      if (decision === "save") {
        if (!await restoreDirtyProjectDocuments(id)) return;
        const state = currentProjects().find((project) => project.id === id);
        if (!state) return;
        for (const tabId of state.tabIds) {
          const tab = tabById[tabId];
          if (tab?.dirty && !await saveTab(tab)) return;
        }
        if (currentProjects().some((project) => project.id === id && projectSession(project).tabs.some((tab) => tab.dirty))) return;
      }
      await removeProject(id);
      setProjectCloseId(undefined);
    } finally { setProjectCloseBusy(false); setConfirmedOperationInProgress(false); }
  };

  const activeProjectIsBlank = () => Boolean(activeProjectId()) && !workspace() && !tabs().length;

  const addProjectTab = async () => {
    if (!canSwitchProject()) return;
    if (activeProjectIsBlank()) return;
    const blank = projects().find((project) => !project.workspace && !project.tabIds.length);
    if (blank) { await selectProject(blank.id); return; }
    setConfirmedOperationInProgress(true);
    try {
      if (authorizationReview()) await cancelPluginAuthorizationReview();
      await transitionToProject(createProject(""), true);
    } finally { setConfirmedOperationInProgress(false); }
  };

  const loadWorkspace = async () => {
    try {
      const selected = await openFolder();
      if (selected) await openWorkspacePath(selected);
    } catch (error) {
      notify(errorMessage(error, "Unable to open folder."));
    }
  };

  const openNewWindowAction = async () => {
    try {
      await openNewWindow();
      if (!isTauri) notify("Opened a new browser window.");
    } catch (error) {
      notify(errorMessage(error, "Unable to open a new window."));
    }
  };

  const readFileForEditor = async (path: string) => {
    const editorChunk = getEditorChunk();
    const file = readFileWithIoLimit(path, "current-document").then(normalizeReadFile);
    const [, result] = await Promise.all([editorChunk, file]);
    return result;
  };

  const imageWorkspaceRoot = (path: string) => {
    const currentWorkspace = workspace();
    if (currentWorkspace && isSameOrDescendantPath(path, currentWorkspace)) return currentWorkspace;
    return isTauri ? parentPath(path) : currentWorkspace ?? "pude-demo";
  };

  const openImageFile = (path: string, size?: number) => {
    markUserOpenedRestorePath(path);
    const existing = tabs().find((tab) => samePath(tab.path, path));
    if (existing) {
      if (existing.language !== "Image" && existing.dirty) {
        notify("Save or close the modified tab before previewing this image.");
        return;
      }
      if (existing.language !== "Image") updateTab(existing.id, { ...makeImageTabChanges(size), revision: existing.revision + 1, savedRevision: existing.revision + 1, contentVersion: existing.contentVersion + 1 });
      setActiveTab(existing.id);
      markSessionDirty();
      setDiffReturnToHistory(false);
      setViewMode("editor");
      syncExternalWatchParents();
      return;
    }
    const tab = makeImageTab(path, size);
    setTabs((items) => [...items, tab]);
    markSessionDirty();
    setActiveTab(tab.id);
    setDiffReturnToHistory(false);
    setViewMode("editor");
    syncExternalWatchParents();
    if (plugins().some((plugin) => plugin.enabled)) {
      const generation = workspaceGeneration;
      void getPluginHostModules().then((host) => {
        if (!disposed && generation === workspaceGeneration) activatePluginsForEvent("onFileOpen", { file: { path, name: baseName(path), language: host.activationLanguageId("Image") } });
      });
    }
  };

  const openFileAction = async () => {
    await loadProjectRuntime();
    if (confirmedOperationInProgress() || appQuitPrepared()) return;
    const generation = workspaceGeneration;
    const selected = await openFileDialog();
    if (!selected || generation !== workspaceGeneration || confirmedOperationInProgress() || appQuitPrepared()) return;
    if (isImagePath(selected)) {
      openImageFile(selected);
      return;
    }
    try {
      const file = await readFileForEditor(selected);
      if (generation !== workspaceGeneration || confirmedOperationInProgress() || appQuitPrepared()) return;
      openReadFile(file);
    } catch (error) {
      if (!disposed && generation === workspaceGeneration) notify(errorMessage(error, "This file cannot be displayed as text."));
    }
  };

  const refreshGit = (showToast = true, path = workspace()): Promise<void> => {
    if (gitRefreshInFlight) {
      gitRefreshPendingPath = path;
      gitRefreshPendingShowToast ||= showToast;
      return gitRefreshInFlight;
    }
    const requestVersion = ++gitRequestVersion;
    if (gitRefreshTimer) {
      window.clearTimeout(gitRefreshTimer);
      gitRefreshTimer = undefined;
    }
    gitRefreshFirstPendingAt = undefined;
    const requestedDirtyState = gitDirtyState;
    const request = (async () => {
      try {
        const previous = git();
        const statusRevision = gitStatusRevision;
        const branchesRevision = gitBranchesRevision;
        const shouldRefreshBranches = requestedDirtyState.branches || gitBranchesDirty || gitBranchesWorkspace !== path;
        const statusPromise = getGitStatus(path);
        let branchError: unknown;
        const branchesPromise = shouldRefreshBranches
          ? getGitBranches(path).catch((error) => { branchError = error; return undefined; })
          : Promise.resolve(gitBranches());
        const status = await statusPromise;
        const branches = await branchesPromise;
        if (requestVersion !== gitRequestVersion || path !== workspace()) return;
        if (statusRevision !== gitStatusRevision || (shouldRefreshBranches && branchesRevision !== gitBranchesRevision)) return;
        if (shouldRefreshBranches) {
          invalidateGitHistory();
        }
        const sameRepository = previous.repositoryRoot !== "" && previous.repositoryRoot === status.repositoryRoot;
        if (!sameRepository) resetGitHistoryPagination();
        setGit({ ...status, error: branchError ? errorMessage(branchError, "Unable to read Git branches.") : null, commits: sameRepository ? previous.commits : [] });
        gitDirtyState = {
          status: statusRevision === gitStatusRevision ? false : gitDirtyState.status,
          branches: shouldRefreshBranches && branchesRevision === gitBranchesRevision ? false : gitDirtyState.branches,
          history: shouldRefreshBranches && branchesRevision === gitBranchesRevision ? true : gitDirtyState.history,
        };
        if (branchError) {
          setGitBranches([]);
          gitBranchesWorkspace = undefined;
          gitBranchesDirty = true;
        } else if (branches) {
          setGitBranches(branches);
          gitBranchesWorkspace = path;
          if (gitBranchesRevision === branchesRevision) gitBranchesDirty = false;
        }
        if (showToast) notify(branchError ? errorMessage(branchError, "Unable to read Git branches.") : "Git status refreshed");
      } catch (error) {
        if (requestVersion !== gitRequestVersion || path !== workspace()) return;
        setGit((current) => ({ ...current, error: errorMessage(error, "Unable to read Git status.") }));
        if (showToast) notify(errorMessage(error, "Unable to read Git status."));
      }
    })();
    gitRefreshInFlight = request;
    void request.finally(() => {
      if (gitRefreshInFlight !== request) return;
      gitRefreshInFlight = undefined;
      if (gitRefreshPendingPath !== undefined && !disposed) {
        const pendingPath = gitRefreshPendingPath;
        const pendingShowToast = gitRefreshPendingShowToast;
        gitRefreshPendingPath = undefined;
        gitRefreshPendingShowToast = false;
        void refreshGit(pendingShowToast, pendingPath);
      }
    });
    return request;
  };

  const waitForGitRefreshSettled = async () => {
    for (;;) {
      const inFlight = gitRefreshInFlight;
      if (inFlight) {
        await inFlight;
        continue;
      }
      if (gitRefreshPendingPath !== undefined) {
        await refreshGit(false, gitRefreshPendingPath);
        continue;
      }
      return;
    }
  };

  const loadGitHistory = async () => {
    const requestWorkspace = workspace();
    const requestGeneration = workspaceGeneration;
    const requestSnapshotKey = git().repositoryRoot ? gitSnapshotKey(git()) : null;
    const isCurrent = () => {
      const currentGit = git();
      return !disposed
        && workspace() === requestWorkspace
        && workspaceGeneration === requestGeneration
        && (currentGit.repositoryRoot ? gitSnapshotKey(currentGit) : null) === requestSnapshotKey;
    };
    try {
      const controller = await getGitHistoryController();
      return isCurrent() ? controller.load() : false;
    } catch (error) {
      if (isCurrent()) notify(errorMessage(error, "Unable to load Git history."));
      return false;
    }
  };
  const loadOlderGitHistory = async () => {
    const requestWorkspace = workspace();
    const requestGeneration = workspaceGeneration;
    const requestSnapshotKey = git().repositoryRoot ? gitSnapshotKey(git()) : null;
    const isCurrent = () => {
      const currentGit = git();
      return !disposed
        && workspace() === requestWorkspace
        && workspaceGeneration === requestGeneration
        && (currentGit.repositoryRoot ? gitSnapshotKey(currentGit) : null) === requestSnapshotKey;
    };
    try {
      const controller = await getGitHistoryController();
      return isCurrent() ? controller.loadOlder() : false;
    } catch (error) {
      if (isCurrent()) notify(errorMessage(error, "Unable to load older Git history."));
      return false;
    }
  };

  const refreshGitHistory = (): Promise<void> => {
    const currentWorkspace = workspace();
    if (!currentWorkspace) return Promise.resolve();
    const generation = workspaceGeneration;
    const existingRefresh = gitHistoryRefreshInFlight;
    if (existingRefresh?.workspace === currentWorkspace && existingRefresh.generation === generation) return existingRefresh.promise;

    gitStatusRevision += 1;
    gitBranchesRevision += 1;
    gitBranchesDirty = true;
    gitDirtyState = allGitDirtyState();
    invalidateGitHistory();

    const request = { workspace: currentWorkspace, generation, promise: Promise.resolve() };
    gitHistoryRefreshInFlight = request;
    request.promise = (async () => {
      try {
        await refreshGit(false, currentWorkspace);
        await waitForGitRefreshSettled();
        if (generation !== workspaceGeneration || workspace() !== currentWorkspace) return;
        if (git().repositoryRoot) await loadGitHistory();
      } finally {
        if (gitHistoryRefreshInFlight === request) gitHistoryRefreshInFlight = undefined;
      }
    })();
    return request.promise;
  };

  const runGitAction = async (request: GitActionRequest) => {
    if (gitMutationInFlight) throw new Error("Another Git operation is already running.");
    gitMutationInFlight = true;
    gitStatusRevision += 1;
    gitBranchesDirty = true;
    gitBranchesRevision += 1;
    try {
      const result = await performGitAction(workspace(), request);
      notify(result.output || `${request.action} completed.`);
    } finally {
      invalidateGitHistory();
      try {
        await refreshGit(false);
        await waitForGitRefreshSettled();
      } finally {
        gitMutationInFlight = false;
      }
    }
  };

  const toggleDirectory = async (entry: DirectoryEntry) => {
    if (entry.kind !== "directory" || confirmedOperationInProgress() || appQuitPrepared()) return;
    const generation = workspaceGeneration;
    if (!entry.loaded || entry.stale) {
      setRoot((current) => updateEntry(current, entry.path, (item) => ({ ...item, expanded: true })));
      try {
        await refreshDirectory(entry.path, generation);
      } catch (error) {
        notify(errorMessage(error, entry.loaded ? "Unable to refresh directory." : "Unable to read directory."));
      }
      return;
    }
    setRoot((current) => updateEntry(current, entry.path, (item) => ({ ...item, expanded: !item.expanded })));
  };

  const openEntry = async (entry: DirectoryEntry) => {
    if (confirmedOperationInProgress() || appQuitPrepared()) return;
    if (entry.recentProject) {
      await openWorkspacePath(entry.path);
      return;
    }
    if (entry.kind === "directory") {
      await toggleDirectory(entry);
      return;
    }
    if (isImagePath(entry.path)) {
      openImageFile(entry.path, entry.size);
      return;
    }
    try {
      const result = await readFileForEditor(entry.path);
      if (confirmedOperationInProgress() || appQuitPrepared()) return;
       if (result.size > 5 * 1024 * 1024) notify("Large file mode enabled: semantic language features and rich Markdown preview are disabled.");
      openReadFile(result);
    } catch (error) {
      notify(errorMessage(error, "This file cannot be displayed as text."));
    }
  };

  const openInFileExplorer = async (entry: DirectoryEntry) => {
    closeFileMenu();
    if (!isTauri) {
      notify("Open in File Explorer is available in the desktop build.");
      return;
    }
    try {
      await revealInFileManager(entry.path);
      notify(`Opened ${entry.name} in File Explorer`);
    } catch (error) {
      notify(errorMessage(error, "Unable to open File Explorer."));
    }
  };

  const openInIntegratedTerminal = (entry: DirectoryEntry) => {
    closeFileMenu();
    const projectId = activeProjectId();
    if (!projectId || !hydrated()) return;
    const directory = entry.kind === "directory" ? entry.path : parentPath(entry.path);
    setTerminalOpenRequests((requests) => ({ ...requests, [projectId]: { id: ++terminalOpenRequestId, directory } }));
    setTerminalInitialized(true);
    setTerminalOpen(true);
  };

  const openProjectSearchResult = async (match: ProjectSearchMatch) => {
    const generation = workspaceGeneration;
    if (confirmedOperationInProgress() || appQuitPrepared()) return;
    if (isImagePath(match.path)) {
      openImageFile(match.path);
      return;
    }
    try {
      const file = await readFileForEditor(match.path);
      if (generation !== workspaceGeneration || confirmedOperationInProgress() || appQuitPrepared()) return;
      openReadFile(file);
      if (match.line) {
        setMarkdownPreviewEnabled(false);
        setGoToLine({ line: match.line, actionId: Date.now() });
      }
    } catch (error) {
      if (generation === workspaceGeneration) notify(errorMessage(error, "Unable to open search result."));
    }
  };

  const copyEntryPath = async (entry: DirectoryEntry, relative: boolean) => {
    closeFileMenu();
    const relativePath = relativePathWithinRoot(entry.path, workspace());
    const value = relative ? relativePath : entry.path;
    const label = relative ? "relative path" : "path";
    if (!value) {
      notify("Copy Relative Path is only available for items inside the current workspace.");
      return;
    }
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable in this window.");
      await navigator.clipboard.writeText(value);
      notify(`Copied ${label}: ${value}`);
    } catch (error) {
      notify(errorMessage(error, `Unable to copy ${label}.`));
    }
  };

  const showFileContextMenu = (entry: DirectoryEntry, x: number, y: number) => {
    setTabMenu(undefined);
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[role=treeitem]");
    contextMenuFocusTarget = row?.querySelector<HTMLElement>("button") ?? undefined;
    setFileMenu({ entry, x, y });
  };

  const openReadFile = (file: ReadFileResult) => {
    markUserOpenedRestorePath(file.path);
    const notifyFileOpen = () => {
      if (!plugins().some((plugin) => plugin.enabled)) return;
      const generation = workspaceGeneration;
      void getPluginHostModules().then((host) => {
        if (!disposed && generation === workspaceGeneration) activatePluginsForEvent("onFileOpen", { file: { path: file.path, name: baseName(file.path), language: host.activationLanguageId(fileLanguageForPath(file.path).label) } });
      });
    };
    const existing = tabs().find((tab) => samePath(tab.path, file.path));
    if (existing) {
      setActiveTab(existing.id);
      markSessionDirty();
      setDiffReturnToHistory(false);
      setViewMode("editor");
      syncExternalWatchParents();
      notifyFileOpen();
      return;
    }
    const tab = makeTab(file);
    setTabs((items) => [...items, tab]);
    getDocumentRevision(tab.id);
    markSessionDirty();
    setActiveTab(tab.id);
    setDiffReturnToHistory(false);
    setViewMode("editor");
    syncExternalWatchParents();
    notifyFileOpen();
  };

  const updateTab = (id: string, changes: Partial<EditorTab>) => {
    const current = tabById[id];
    if (!current) return;
    const selectionFallback = editorSelectionFallbackAfterUpdate(current, changes);
    if (selectionFallback !== current.selectionFallback || Object.prototype.hasOwnProperty.call(changes, "selectionFallback")) {
      changes = { ...changes, selectionFallback };
    }
    setTabById(id, changes);
    if (Object.keys(changes).some((key) => key !== "cursorLine" && key !== "cursorColumn")) markSessionDirty();
  };

  const applySavedSnapshot = (snapshot: SaveSnapshot, result: { modifiedAt?: number; size?: number; fingerprint?: string }) => {
    const current = tabById[snapshot.tabId];
    if (!current || !samePath(current.path, snapshot.path)) return;
    const currentSnapshot = documentController.getHandle(current.id)?.getSnapshot();
    const currentContent = currentSnapshot?.content ?? normalizeDocumentContent(getDocumentText(current));
    const currentLineEndings = currentSnapshot?.lineEndings ?? normalizeLineEndingMap(currentContent, current.lineEndings, current.lineEnding);
    const changes = savedTabChanges(current, snapshot, { content: currentContent, lineEndings: currentLineEndings }, result);
    const currentDirty = changes.dirty === true;
    updateTab(current.id, changes);
    if (!currentDirty) clearRecovery(current.id);
    else scheduleRecovery(current.id);
    if (tabOrder().includes(current.id)) scheduleGitRefresh();
    if (tabOrder().includes(current.id) && plugins().some((plugin) => plugin.enabled)) {
      const generation = workspaceGeneration;
      void getPluginHostModules().then((host) => {
        if (!disposed && generation === workspaceGeneration) activatePluginsForEvent("onFileSave", { file: { path: current.path, name: current.name, language: host.activationLanguageId(fileLanguageForPath(current.path).label) } });
      });
    }
    if (!currentDirty) notify(`Saved ${current.name}`);
  };

  let saveControllerPromise: Promise<SaveController> | undefined;
  const getSaveController = () => saveControllerPromise ??= import("./lib/save-controller").then(({ createSaveController }) => createSaveController({
    saveFile, onSaved: applySavedSnapshot,
    onSaveFailed: (_snapshot, error) => notify(errorMessage(error, "Unable to save file.")),
  }));
  const externalConflictController = createExternalConflictController(
    {
      queued: externalConflicts,
      setQueued: (updater) => setExternalConflicts(updater),
    },
    {
      readFile,
      normalizeReadFile,
      getWorkspaceGeneration: () => workspaceGeneration,
      getTab: (id) => tabById[id],
      samePath,
      updateTab,
      bumpDocumentContentRevision: (tabId) => getDocumentRevision(tabId).bump(),
      getDocumentText,
      buildTextDiff,
      openDiskDiff: (path, diffText) => {
        setDiff({ path, diff: diffText, staged: false, label: "EDITOR VS DISK" });
        setViewMode("diff");
      },
      notify,
      errorMessage,
    },
  );

  const saveTab = async (tab = activeTab()): Promise<boolean> => {
    if (!tab || tab.language === "Image") return false;
    const liveSnapshot = documentController.getHandle(tab.id)?.getSnapshot();
    const content = liveSnapshot?.content ?? normalizeDocumentContent(getDocumentText(tab));
    const lineEndings = liveSnapshot?.lineEndings ?? normalizeLineEndingMap(content, tab.lineEndings, tab.lineEnding);
    const snapshot: SaveSnapshot = { tabId: tab.id, path: tab.path, revision: liveSnapshot?.revision ?? tab.revision, content, lineEnding: liveSnapshot?.lineEnding ?? lineEndingFromMap(lineEndings, tab.lineEnding), lineEndings, bom: liveSnapshot?.bom ?? tab.bom === true, encoding: liveSnapshot?.encoding ?? tab.encoding, expectedModifiedAt: tab.diskModifiedAt, expectedSize: tab.diskSize, expectedFingerprint: tab.diskFingerprint };
    const result = await (await getSaveController()).enqueue(snapshot);
    return result.ok;
  };

  const restoreDirtyProjectDocuments = async (projectId?: string): Promise<boolean> => {
    for (const state of currentProjects().filter((project) => !projectId || project.id === projectId)) {
      const selected = () => state.id === activeProjectId();
      const current = () => selected() ? captureProject() : projects().find((project) => project.id === state.id)!;
      const scope = sessionScope;
      const restored = await projectRuntime!.restoreProjectDocuments({
        session: state.restoreMetadata, intent: state.restoreIntent, scope, recoveries: restoredCheckpointRecoveries, dirtyOnly: true,
        isCurrent: () => !disposed && scope === sessionScope && projects().some((project) => project.id === state.id),
        readDocument: readFile, normalizeReadFile, createImageTab: makeImageTab, getTabs: () => current().tabIds.map((id) => tabById[id]).filter(Boolean), getIntent: () => current().restoreIntent,
        onTabs: (items) => {
          if (selected()) setTabs(items);
          else batch(() => { for (const tab of items) setTabById(tab.id, tab); setProjects((projects) => projects.map((project) => project.id === state.id ? { ...project, tabIds: items.map((tab) => tab.id) } : project)); });
        },
        onIntent: (intent) => {
          if (selected()) restoreIntent = intent;
          else setProjects((items) => items.map((project) => project.id === state.id ? { ...project, restoreIntent: intent } : project));
        },
        onConflict: (tab) => {
          if (selected()) externalConflictController.queue(tab);
          else setProjects((items) => items.map((project) => project.id === state.id ? { ...project, conflicts: [...project.conflicts, tab] } : project));
        },
        onFailure: () => notify("Some unsaved files could not be restored. Their recovery data has been retained."),
      });
      if (!restored) return false;
    }
    return true;
  };

  const saveAll = async (): Promise<boolean> => {
    if (!await restoreDirtyProjectDocuments()) return false;
    let failed = false;
    for (const tab of allLoadedTabs()) {
      if (tab.dirty && !(await saveTab(tab))) failed = true;
    }
    const complete = !failed && !windowHasDirtyTabs();
    notify(complete ? "All changes saved" : "Some changes could not be saved.");
    return complete;
  };

  const discardDirtyTabs = () => {
    for (const tab of allLoadedTabs()) {
      if (!tab.dirty) continue;
      clearRecovery(tab.id);
      const snapshot = documentController.getHandle(tab.id)?.getSnapshot();
      const content = snapshot?.content ?? getDocumentText(tab);
      const lineEndings = snapshot?.lineEndings ?? normalizeLineEndingMap(content, tab.lineEndings, tab.lineEnding);
      const bom = snapshot?.bom ?? tab.bom === true;
      updateTab(tab.id, {
        content, lineEndings, bom, dirty: false,
        savedContent: content, savedLineEndings: lineEndings, savedBom: bom,
        savedRevision: tab.revision, normalizedContentVersion: tab.contentVersion,
        normalizedSavedRevision: tab.revision,
      });
    }
    const discardPending = (metadata: SessionMetadata | undefined) => metadata ? { ...metadata, tabs: metadata.tabs.map((tab) => {
      if (tab.dirty) clearRecovery(tab.id);
      return { ...tab, dirty: false };
    }) } : undefined;
    restoreMetadata = discardPending(restoreMetadata);
    setProjects((items) => items.map((project) => ({ ...project, restoreMetadata: discardPending(project.restoreMetadata) })));
  };

  const captureDirtyTabs = () => projectRuntime!.captureDirtyProjectTabs(allLoadedTabs(), documentController.getHandle);

  const restoreCloseAttempt = async (workspacePath: string, discardedTabs: EditorTab[], releaseUiBeforeStorage = false, projectSnapshot?: ProjectWorkspaceState[]) => {
    closeCleanupGeneration += 1;
    const restoreCloseGeneration = closeCleanupGeneration;
    if (workspace() !== workspacePath) return;
    const restoreGeneration = workspaceGeneration;
    if (projectSnapshot) {
      setProjects(projectSnapshot);
      const active = projectSnapshot.find((project) => project.id === activeProjectId());
      restoreMetadata = active?.restoreMetadata;
      restoreIntent = active?.restoreIntent;
      for (const project of projectSnapshot) {
        for (const tab of projectSession(project).tabs.filter((tab) => tab.dirty)) {
          if (tabById[tab.id]) continue;
          const snapshot = restoredCheckpointRecoveries?.[recoveryKey(tab.id)];
          if (snapshot) { pendingRecoverySnapshots.set(recoveryKey(tab.id), { ...snapshot, version: 1 }); pendingRecoveryRemovals.delete(recoveryKey(tab.id)); }
        }
      }
    }
    if (discardedTabs.length) {
      const originals = new Map(discardedTabs.map((tab) => [tab.id, tab]));
      for (const [id, tab] of originals) if (tabById[id]) setTabById(id, tab);
    }
    sessionLease = undefined;
    if (releaseUiBeforeStorage) blockSessionPersistence("Session recovery is being restored after the application quit was cancelled.");
    watcherSessionId = undefined;
    watcherNeedsRestart = true;
    void restartWatcher();
    scheduleGitRefresh(allGitDirtyState());
    await reattachSessionWindow(workspacePath, restoreGeneration, restoreCloseGeneration);
    if (closeCleanupGeneration !== restoreCloseGeneration || workspaceGeneration !== restoreGeneration || workspace() !== workspacePath) return;
    for (const tab of discardedTabs) {
      if (tab.dirty) persistRecovery(tab.id);
    }
    const recoveryRestored = await flushRecoveryWrites();
    if (closeCleanupGeneration !== restoreCloseGeneration || workspaceGeneration !== restoreGeneration || workspace() !== workspacePath) return;
    if (!recoveryRestored) notify("Session recovery could not be restored after the window stayed open.");
  };

  const flushWindowBeforeClose = async (discard: boolean, timeoutMs = 3000): Promise<boolean> => {
    const cleanupGeneration = ++closeCleanupGeneration;
    const closingWorkspace = workspace();
    const closingLease = sessionLease;
    if (discard) discardDirtyTabs();
    recoveryScheduler.flush((tabId) => persistRecovery(tabId));
    if (sessionPersistTimer) {
      window.clearTimeout(sessionPersistTimer);
      sessionPersistTimer = undefined;
    }
    if (cursorPersistTimer) {
      window.clearTimeout(cursorPersistTimer);
      cursorPersistTimer = undefined;
      persistCursorPositions();
    }
    if (settingsPersistTimer) {
      window.clearTimeout(settingsPersistTimer);
      settingsPersistTimer = undefined;
      persistSettings();
    }
    const finishCloseCleanup = async (): Promise<boolean> => {
      let succeeded = true;
      try {
        if (!await flushRecoveryWrites()) {
          succeeded = false;
          console.warn("Session state could not be saved before closing.");
        }
      } catch (error) {
        succeeded = false;
        emitDiagnostic("session.close", error);
      }
      if (cleanupGeneration !== closeCleanupGeneration) return false;
      if (closingWorkspace) {
        try {
          await cancelWorkspaceOperations(closingWorkspace);
        } catch (error) {
          succeeded = false;
          emitDiagnostic("window.cancel", error);
        }
      }
      if (cleanupGeneration !== closeCleanupGeneration) return false;
      if (closingLease && sessionLease === closingLease) {
        sessionLease = undefined;
        if (!await sessionLeaseReleaseQueue.release(closingLease)) succeeded = false;
      }
      if (!await sessionLeaseReleaseQueue.releaseAll()) succeeded = false;
      return cleanupGeneration === closeCleanupGeneration && succeeded;
    };
    if (timeoutMs <= 0) return finishCloseCleanup();
    let closeCleanupTimedOut = false;
    let closeCleanupTimer = 0;
    const result = await Promise.race([
      finishCloseCleanup().then((succeeded) => ({ timedOut: false, succeeded })),
      new Promise<{ timedOut: true; succeeded: false }>((resolve) => {
        closeCleanupTimer = window.setTimeout(() => { closeCleanupTimedOut = true; resolve({ timedOut: true, succeeded: false }); }, timeoutMs);
      }),
    ]);
    window.clearTimeout(closeCleanupTimer);
    if (closeCleanupTimedOut) {
      if (cleanupGeneration === closeCleanupGeneration) closeCleanupGeneration += 1;
      console.warn("Close cleanup timed out.");
    }
    return result.succeeded;
  };

  const closeWindow = async (decision: AppQuitDecision = "preserve", confirmed = false) => {
    if (!isTauri || closeSaving() || confirmedOperationInProgress() || appQuitPrepared() || dialogRequestInFlight || projectCloseId() || (closePromptOpen() && !confirmed)) return;
    if (!confirmed && windowHasDirtyTabs()) {
      setClosePromptOpen(true);
      return;
    }
    const closingWorkspace = workspace();
    const discardedTabs = decision === "discard" ? captureDirtyTabs() : [];
    const projectSnapshot = decision === "discard" ? currentProjects() : undefined;
    let cleanupStarted = false;
    setConfirmedOperationInProgress(true);
    setCloseSaving(true);
    try {
      if (decision === "save" && !(await saveAll())) return;
      cleanupStarted = true;
      if (!await flushWindowBeforeClose(decision === "discard")) {
        setClosePromptOpen(false);
        void restoreCloseAttempt(closingWorkspace, discardedTabs, true, projectSnapshot).catch((error) => {
          emitDiagnostic("session.restore", error);
          notify(errorMessage(error, "The window stayed open, but session recovery could not be restored."));
        });
        cleanupStarted = false;
        notify("The window stayed open because its session could not be closed safely.");
        return;
      }
      setClosePromptOpen(false);
      await (await getWindowApi()).getCurrentWindow().destroy();
    } catch (error) {
      if (cleanupStarted) {
        setClosePromptOpen(false);
        void restoreCloseAttempt(closingWorkspace, discardedTabs, true, projectSnapshot).catch((restoreError) => {
          emitDiagnostic("session.restore", restoreError);
          notify(errorMessage(restoreError, "The window stayed open, but session recovery could not be restored."));
        });
      }
      notify(errorMessage(error, "Unable to close window."));
    } finally {
      setCloseSaving(false);
      setConfirmedOperationInProgress(false);
    }
  };

  const clearAppQuitState = (requestId: string) => {
    if (appQuitRequestId !== requestId) return;
    appQuitRequestId = undefined;
    appQuitDecision = undefined;
    setAppQuitPrepared(false);
    setClosePromptOpen(false);
  };

  const replyToAppQuitPrepare = async (requestId: string, decision: AppQuitDecision | "cancel") => {
    if (appQuitRequestId !== requestId) return;
    if (decision === "cancel") {
      appQuitRequestId = undefined;
      appQuitDecision = undefined;
      setAppQuitPrepared(false);
      setClosePromptOpen(false);
    } else {
      appQuitDecision = decision;
      setAppQuitPrepared(true);
      setClosePromptOpen(false);
    }
    try {
      await invokeQuitCommand("app_quit_prepare_reply", { requestId, decision });
    } catch (error) {
      clearAppQuitState(requestId);
      notify(errorMessage(error, "Unable to confirm the application quit request."));
    }
  };

  const handleAppQuitPrepare = (payload: AppQuitPreparePayload) => {
    const requestId = payload?.requestId;
    if (!requestId || appQuitRequestId === requestId) return;
    if (appQuitRequestId) {
      void invokeQuitCommand("app_quit_prepare_reply", { requestId, decision: "cancel" });
      return;
    }
    appQuitRequestId = requestId;
    appQuitDecision = undefined;
    if (closeSaving() || confirmedOperationInProgress() || dialogRequestInFlight || projectCloseId() || !hydrated()) {
      void replyToAppQuitPrepare(requestId, "cancel");
    } else if (windowHasDirtyTabs()) {
      setClosePromptOpen(true);
    } else {
      void replyToAppQuitPrepare(requestId, "save");
    }
  };

  const handleAppQuitAbort = (payload: AppQuitAbortPayload) => {
    const snapshot = appQuitCommitSnapshot?.requestId === payload.requestId ? appQuitCommitSnapshot : undefined;
    let restoration: Promise<void> | undefined;
    if (snapshot) {
      appQuitCommitSnapshot = undefined;
      try {
        restoration = restoreCloseAttempt(snapshot.workspace, snapshot.discardedTabs, true, snapshot.projects);
      } catch (error) {
        emitDiagnostic("window.restore", error);
      }
    }
    clearAppQuitState(payload.requestId);
    if (payload.error) notify(`Application quit was cancelled: ${payload.error}`);
    if (restoration) void restoration.catch((error) => {
      emitDiagnostic("window.restore", error);
      notify(`The window stayed open, but session recovery could not be restored: ${errorMessage(error, "unknown error")}`);
    });
  };

  const handleAppQuitCommit = async (payload: AppQuitCommitPayload) => {
    if (appQuitRequestId !== payload.requestId || appQuitDecision !== payload.decision) return;
    appQuitCommitSnapshot = {
      requestId: payload.requestId,
      workspace: workspace(),
      projects: payload.decision === "discard" ? currentProjects() : undefined,
      discardedTabs: payload.decision === "discard"
        ? captureDirtyTabs()
        : [],
    };
    setCloseSaving(true);
    try {
      const cleanupSucceeded = await flushWindowBeforeClose(payload.decision === "discard", 18000);
      if (!cleanupSucceeded) throw new Error("This window could not finish saving its session before quit.");
      await invokeQuitCommand("app_quit_commit_ready", { requestId: payload.requestId });
    } catch (error) {
      emitDiagnostic("window.close", error);
      notify(errorMessage(error, "Unable to safely close this application window."));
    } finally {
      setCloseSaving(false);
    }
  };

  const handleCloseDialogSave = async () => {
    const requestId = appQuitRequestId;
    if (!requestId) {
      void closeWindow("save", true);
      return;
    }
    if (closeSaving()) return;
    setCloseSaving(true);
    try {
      const saved = await saveAll();
      await replyToAppQuitPrepare(requestId, saved ? "save" : "cancel");
    } catch (error) {
      notify(errorMessage(error, "Unable to save all files before quitting."));
      await replyToAppQuitPrepare(requestId, "cancel");
    } finally {
      setCloseSaving(false);
    }
  };

  const handleCloseDialogPreserve = () => {
    const requestId = appQuitRequestId;
    if (requestId) void replyToAppQuitPrepare(requestId, "preserve");
    else void closeWindow("preserve", true);
  };

  const handleCloseDialogDiscard = () => {
    const requestId = appQuitRequestId;
    if (requestId) void replyToAppQuitPrepare(requestId, "discard");
    else void closeWindow("discard", true);
  };

  const handleCloseDialogCancel = () => {
    const requestId = appQuitRequestId;
    if (requestId) void replyToAppQuitPrepare(requestId, "cancel");
    else setClosePromptOpen(false);
  };

  onMount(() => {
    if (!isTauri) return;
    let active = true;
    const unlisteners: Array<() => void> = [];
    void import("@tauri-apps/api/event").then(({ listen }) => Promise.all([
      listen<AppQuitPreparePayload>("app-quit-prepare", ({ payload }) => handleAppQuitPrepare(payload)),
      listen<AppQuitCommitPayload>("app-quit-commit", ({ payload }) => { void handleAppQuitCommit(payload); }),
      listen<AppQuitAbortPayload>("app-quit-abort", ({ payload }) => { void handleAppQuitAbort(payload); }),
    ])).then(async (registered) => {
      if (!active) {
        registered.forEach((unlisten) => unlisten());
        return;
      }
      unlisteners.push(...registered);
      await invokeQuitCommand("app_quit_events_ready");
    }).catch((error) => {
      emitDiagnostic("window.close", error);
      notify(errorMessage(error, "Application quit protection could not be initialized."));
    });
    onCleanup(() => {
      active = false;
      unlisteners.forEach((unlisten) => unlisten());
    });
  });

  const closeTab = async (id: string) => {
    const closing = tabs().find((tab) => tab.id === id);
    if (!closing) return;
    const requestGeneration = workspaceGeneration;
    const snapshot = captureTabOperation(closing);
    if (closing.dirty) {
      const confirmed = await requestConfirmation({
        title: `Close ${closing.name}?`,
        message: "This file has unsaved changes. Close it and discard them?",
        confirmLabel: "Close and discard",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) return;
      if (requestGeneration !== workspaceGeneration || !tabOperationIsCurrent(snapshot)) {
        notify("This file changed while waiting for confirmation. It stayed open.");
        return;
      }
    }
    if (requestGeneration !== workspaceGeneration || !tabOperationIsCurrent(snapshot)) return;
    if (restoreIntent) restoreIntent = markRestoreTabCancelled(restoreIntent, id);
    const closedSnapshot = { ...closing, content: getDocumentText(closing) };
    const items = tabs();
    const index = items.findIndex((tab) => tab.id === id);
    const remaining = items.filter((tab) => tab.id !== id);
    setLastClosedTab(closedSnapshot);
    setTabs(remaining);
    clearRecovery(id);
    documentController.release(id);
    markSessionDirty();
    syncExternalWatchParents();
    if (activeTabId() === id) setActiveTab(remaining[Math.max(0, index - 1)]?.id);
    if (!remaining.length && !historyViewActive()) setViewMode("editor");
    externalConflictController.dismiss(id);
  };

  const openHistoryTab = () => {
    setHistoryTabOpen(true);
    diffRequestVersion += 1;
    setDiff(undefined);
    setDiffReturnToHistory(false);
    setViewMode("history");
  };

  const closeHistoryTab = () => {
    const historyOwnsView = viewMode() === "history" || diffReturnToHistory();
    diffRequestVersion += 1;
    setHistoryTabOpen(false);
    setDiffReturnToHistory(false);
    if (historyOwnsView) {
      setDiff(undefined);
      setViewMode("editor");
    }
  };

  const reopenClosedTab = () => {
    const tab = lastClosedTab();
    if (!tab) return;
    markUserOpenedRestorePath(tab.path);
    setTabs((items) => [...items, tab]);
    if (tab.dirty) scheduleRecovery(tab.id);
    markSessionDirty();
    setActiveTab(tab.id);
    setLastClosedTab(undefined);
    syncExternalWatchParents();
    setDiffReturnToHistory(false);
    setViewMode("editor");
  };

  const cycleTab = (direction: 1 | -1) => {
    const items = tabs();
    if (!items.length) return;
    const index = items.findIndex((tab) => tab.id === activeTabId());
    const next = (index + direction + items.length) % items.length;
    setActiveTab(items[next].id);
    markSessionDirty();
    setDiffReturnToHistory(false);
    setViewMode("editor");
  };

  const returnToDiffFile = async () => {
    const currentDiff = diff();
    if (diffReturnToHistory() && historyTabOpen()) {
      setDiffReturnToHistory(false);
      setDiff(undefined);
      setViewMode("history");
      return;
    }
    setDiffReturnToHistory(false);
    if (!currentDiff) {
      setViewMode("editor");
      return;
    }

    const repositoryRoot = git().repositoryRoot || workspace();
    const existingTab = tabs().find((tab) => sameGitPath(tab.path, currentDiff.path, repositoryRoot));
    if (existingTab) {
      setActiveTab(existingTab.id);
      markSessionDirty();
      setViewMode("editor");
      return;
    }

    const targetPath = joinPath(repositoryRoot, currentDiff.path);
    const requestVersion = ++diffRequestVersion;
    const generation = workspaceGeneration;
    try {
      if (isImagePath(targetPath)) {
        if (!await pathExists(targetPath)) throw new Error(`The image file no longer exists: ${currentDiff.path}.`);
        if (requestVersion !== diffRequestVersion || generation !== workspaceGeneration || currentDiff !== diff()) return;
        openImageFile(targetPath);
        return;
      }

      const file = await readFileForEditor(targetPath);
      if (requestVersion !== diffRequestVersion || generation !== workspaceGeneration || currentDiff !== diff()) return;
      openReadFile(file);
    } catch (error) {
      if (requestVersion !== diffRequestVersion || generation !== workspaceGeneration || currentDiff !== diff()) return;
      if (activeTab()) {
        setViewMode("editor");
        notify(`${errorMessage(error, `Unable to open ${currentDiff.path}.`)} Showing the current editor instead.`);
      } else {
        notify(errorMessage(error, `Unable to open ${currentDiff.path}.`));
      }
    }
  };

  const openDiff = async (file: GitFileStatus, staged: boolean, untrackedHint?: boolean) => {
    const requestVersion = ++diffRequestVersion;
    const generation = workspaceGeneration;
    const requestedWorkspace = workspace();
    try {
      const result = await getGitDiff(requestedWorkspace, file.path, staged, untrackedHint);
      if (disposed || requestVersion !== diffRequestVersion || generation !== workspaceGeneration || requestedWorkspace !== workspace()) return;
      setDiffReturnToHistory(false);
      setDiff({ ...result, untrackedHint, label: staged ? "STAGED CHANGES" : "WORKING TREE" });
      setViewMode("diff");
    } catch (error) {
      if (disposed || requestVersion !== diffRequestVersion || generation !== workspaceGeneration || requestedWorkspace !== workspace()) return;
      notify(errorMessage(error, "Unable to open Git diff."));
    }
  };

  const openCommitDiff = async (commit: GitCommit, file: GitCommitFile, returnToHistory = false) => {
    const requestVersion = ++diffRequestVersion;
    const generation = workspaceGeneration;
    const requestedWorkspace = workspace();
    try {
      const result = await getGitCommitDiff(requestedWorkspace, commit.hash, file.path);
      if (disposed || requestVersion !== diffRequestVersion || generation !== workspaceGeneration || requestedWorkspace !== workspace()) return;
      setDiffReturnToHistory(returnToHistory);
      setDiff({ ...result, commit: commit.hash, label: `COMMIT ${commit.shortHash}` });
      setViewMode("diff");
    } catch (error) {
      if (disposed || requestVersion !== diffRequestVersion || generation !== workspaceGeneration || requestedWorkspace !== workspace()) return;
      notify(errorMessage(error, "Unable to open Git diff."));
    }
  };

  const expandDiffContext = async () => {
    const current = diff();
    if (!current?.nextContextLines || diffContextLoading()) return;
    const requestVersion = ++diffRequestVersion;
    const generation = workspaceGeneration;
    const requestedWorkspace = workspace();
    setDiffContextLoading(true);
    try {
      const result = current.commit
        ? await getGitCommitDiff(requestedWorkspace, current.commit, current.path, current.nextContextLines)
        : await getGitDiff(requestedWorkspace, current.path, current.staged, current.untrackedHint, current.nextContextLines);
      if (generation === workspaceGeneration && requestVersion === diffRequestVersion && current === diff()) setDiff({ ...current, ...result, label: current.label });
    } catch (error) {
      if (generation === workspaceGeneration && requestVersion === diffRequestVersion) notify(errorMessage(error, "Unable to expand diff context."));
    } finally { setDiffContextLoading(false); }
  };

  const openCommitDiffFromHistory = (commit: GitCommit, file: GitCommitFile) => void openCommitDiff(commit, file, true);

  const requestFind = (action: SearchRequest["action"] = "find") => {
    const target = activeTab();
    if (!target || target.language === "Image" || viewMode() !== "editor") return;
    setSearchActionTargetTabId(target.id);
    setSearch((current) => ({
      ...current,
      query: findInputRef?.value ?? current.query,
      replace: replaceInputRef?.value ?? current.replace,
      action,
      actionId: current.actionId + 1,
    }));
  };
  const acknowledgeSearchAction = (tabId: string, actionId: number) => {
    if (searchActionTargetTabId() !== tabId || search().actionId !== actionId) return;
    setSearch((current) => ({ ...current, action: null }));
    setSearchActionTargetTabId(undefined);
  };
  const updateSearch = (changes: Partial<SearchRequest>) => {
    setSearchActionTargetTabId(undefined);
    setSearch((current) => ({ ...current, ...changes, action: null }));
  };
  createEffect(() => {
    const target = searchActionTargetTabId();
    if (target && (activeTabId() !== target || !searchOpen() || viewMode() !== "editor")) {
      setSearchActionTargetTabId(undefined);
      setSearch((current) => ({ ...current, action: null }));
    }
  });
  const showFind = (replace = false) => {
    setSearchOpen(true);
    setReplaceOpen(replace);
    window.setTimeout(() => document.querySelector<HTMLInputElement>(".find-input")?.focus(), 0);
  };

  const focusHistorySearch = () => {
    if (viewMode() === "diff") {
      setDiff(undefined);
      setDiffReturnToHistory(false);
      setViewMode("history");
    }
    window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(".editor-slot:not(.editor-slot-hidden) .git-history-full .git-history-search input");
      input?.focus();
      input?.select();
    });
  };

  const findAction = () => {
    if (historyViewActive()) focusHistorySearch();
    else showFind(false);
  };

  const goToLineAction = async () => {
    if (confirmedOperationInProgress() || appQuitPrepared()) return;
    const tabId = activeTabId();
    const tab = tabId ? tabById[tabId] : undefined;
    if (!tabId || !tab) return;
    const generation = workspaceGeneration;
    const snapshot = captureTabOperation(tab);
    const value = await requestInput({ title: "Go to line", label: "Line number", initialValue: "1", placeholder: "1", submitLabel: "Go" });
    if (value === null) return;
    if (generation !== workspaceGeneration || activeTabId() !== tabId || !tabOperationIsCurrent(snapshot) || confirmedOperationInProgress() || appQuitPrepared()) {
      notify("The active file changed while Go to line was open.");
      return;
    }
    const requestedLine = Number(value);
    if (!Number.isSafeInteger(requestedLine) || requestedLine < 1) {
      notify("Enter a positive whole line number.");
      return;
    }
    const lineCount = getDocumentText(tabById[tabId]!).split("\n").length;
    const line = Math.min(requestedLine, Math.max(1, lineCount));
    setGoToLine({ line, actionId: Date.now() });
  };

  const renameOpenTabs = (from: string, to: string) => {
    const normalizedFrom = pathKey(from);
    const nextTabs = tabs().map((tab) => {
      const normalizedPath = pathKey(tab.path);
      if (normalizedPath !== normalizedFrom && !normalizedPath.startsWith(`${normalizedFrom}/`)) return tab;
      const nextPath = replacePathPrefix(tab.path, from, to);
      return { ...tab, path: nextPath, name: baseName(nextPath), language: fileLanguageForPath(nextPath).label };
    });
    const activePath = tabs().find((tab) => tab.id === activeTabId())?.path;
    setTabs(nextTabs);
    markSessionDirty();
    syncExternalWatchParents();
    if (activePath) {
      const nextActive = nextTabs.find((tab) => samePath(tab.path, replacePathPrefix(activePath, from, to)));
      if (nextActive) setActiveTab(nextActive.id);
    }
  };

  const contextAction = async (action: "new-file" | "new-folder" | "rename" | "delete", entry: DirectoryEntry) => {
    if (confirmedOperationInProgress() || appQuitPrepared()) return;
    const requestGeneration = workspaceGeneration;
    const requestWorkspace = workspace();
    const targetDirectory = entry.kind === "directory" ? entry.path : parentPath(entry.path);
    if (action === "new-file" || action === "new-folder") {
      const name = await requestInput({
        title: action === "new-file" ? "New file" : "New folder",
        label: action === "new-file" ? "File name" : "Folder name",
        placeholder: action === "new-file" ? "example.ts" : "folder-name",
        submitLabel: "Create",
      });
      if (!name) return;
      if (!isSafeEntryName(name)) {
        notify("Use a single file or folder name without path separators.");
        return;
      }
      if (requestGeneration !== workspaceGeneration || requestWorkspace !== workspace() || confirmedOperationInProgress() || appQuitPrepared()) return;
      setConfirmedOperationInProgress(true);
      try {
        if (!await pathExists(targetDirectory) || requestGeneration !== workspaceGeneration || requestWorkspace !== workspace()) {
          notify("The destination folder changed. Try again.");
          return;
        }
        const path = joinPath(targetDirectory, name);
        if (action === "new-file") await createFile(path); else await createDirectory(path);
        notify(`${action === "new-file" ? "Created" : "Created folder"} ${name}`);
        if (requestGeneration === workspaceGeneration && requestWorkspace === workspace()) await refreshRoot(targetDirectory);
      } catch (error) {
        notify(errorMessage(error, "Unable to create item."));
      } finally {
        setConfirmedOperationInProgress(false);
      }
    }
    if (action === "rename") {
      const affectedSnapshots = tabs().filter((tab) => isSameOrDescendantPath(tab.path, entry.path)).map(captureTabOperation);
      const name = await requestInput({ title: `Rename ${entry.name}`, label: "New name", initialValue: entry.name, submitLabel: "Rename" });
      if (!name || name === entry.name) return;
      if (!isSafeEntryName(name)) {
        notify("Use a single file or folder name without path separators.");
        return;
      }
      if (requestGeneration !== workspaceGeneration || requestWorkspace !== workspace() || confirmedOperationInProgress() || appQuitPrepared() || !tabOperationsAreCurrent(affectedSnapshots)) return;
      setConfirmedOperationInProgress(true);
      try {
        const sourceExists = await pathExists(entry.path);
        if (!sourceExists || requestGeneration !== workspaceGeneration || requestWorkspace !== workspace() || !tabOperationsAreCurrent(affectedSnapshots)) {
          notify("The file or folder changed. It was not renamed.");
          return;
        }
        const nextPath = joinPath(parentPath(entry.path), name);
        await renamePath(entry.path, nextPath);
        renameOpenTabs(entry.path, nextPath);
        setRoot((current) => renameEntryPaths(current, entry.path, nextPath));
        notify(`Renamed to ${name}`);
        if (requestGeneration === workspaceGeneration && requestWorkspace === workspace()) await refreshRoot(parentPath(nextPath));
      } catch (error) {
        notify(errorMessage(error, "Unable to rename item."));
      } finally {
        setConfirmedOperationInProgress(false);
      }
    }
    if (action === "delete") {
      const affectedTabs = tabs().filter((tab) => isSameOrDescendantPath(tab.path, entry.path));
      const affectedSnapshots = affectedTabs.map(captureTabOperation);
      const hasDirtyTabs = affectedTabs.some((tab) => tab.dirty);
      const prompt = deleteConfirmationMessage(entry.name, windowPlatform, affectedTabs.length, hasDirtyTabs);
      const confirmed = await requestConfirmation({
        title: `Move ${entry.name} to ${trashLocationLabel(windowPlatform)}?`,
        message: prompt,
        confirmLabel: `Move to ${trashLocationLabel(windowPlatform)}`,
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) return;
      if (confirmedOperationInProgress() || appQuitPrepared()) return;
      setConfirmedOperationInProgress(true);
      try {
        const currentAffected = tabs().filter((tab) => isSameOrDescendantPath(tab.path, entry.path));
        const sourceExists = await pathExists(entry.path);
        const latestAffected = tabs().filter((tab) => isSameOrDescendantPath(tab.path, entry.path)).map(captureTabOperation);
        if (!sourceExists || requestGeneration !== workspaceGeneration || requestWorkspace !== workspace() || !sameTabOperations(affectedSnapshots, latestAffected)) {
          notify("The file or folder changed while waiting for confirmation. Nothing was moved.");
          return;
        }
        if (!sameTabOperations(affectedSnapshots, currentAffected.map(captureTabOperation))) {
          notify("An affected file changed while waiting for confirmation. Nothing was moved.");
          return;
        }
        await deletePath(entry.path);
        if (affectedTabs.length) {
          const affectedIds = new Set(affectedTabs.map((tab) => tab.id));
          const remaining = tabs().filter((tab) => !affectedIds.has(tab.id));
          const lastClosed = affectedTabs.at(-1);
          if (lastClosed) setLastClosedTab({ ...lastClosed, content: getDocumentText(lastClosed) });
          setTabs(remaining);
          for (const affected of affectedTabs) {
            clearRecovery(affected.id);
            documentController.release(affected.id);
          }
          markSessionDirty();
          syncExternalWatchParents();
          if (affectedIds.has(activeTabId() ?? "")) setActiveTab(remaining[0]?.id);
        }
        notify(`Moved ${entry.name} to ${trashLocationLabel(windowPlatform)}`);
        if (requestGeneration === workspaceGeneration && requestWorkspace === workspace()) await refreshRoot(parentPath(entry.path));
      } catch (error) {
        notify(errorMessage(error, "Unable to delete item."));
      } finally {
        setConfirmedOperationInProgress(false);
      }
    }
  };

  const refreshDirectory = async (path: string, generation = workspaceGeneration) => {
    if (generation !== workspaceGeneration || disposed) return false;
    const currentWorkspace = workspace();
    if (!currentWorkspace) { setRoot(makeRecentProjectsRoot(recentProjects())); return false; }
    const epoch = directoryRefreshEpoch;
    const coordinator = await getDirectoryRefreshCoordinator();
    if (epoch !== directoryRefreshEpoch || generation !== workspaceGeneration || currentWorkspace !== workspace() || disposed) return false;
    return coordinator.refresh(path);
  };
  const scheduleDirectoryRefresh = (path: string) => {
    const currentWorkspace = workspace();
    if (!currentWorkspace || disposed) return;
    const generation = workspaceGeneration;
    const epoch = directoryRefreshEpoch;
    void getDirectoryRefreshCoordinator().then((coordinator) => {
      if (epoch !== directoryRefreshEpoch || generation !== workspaceGeneration || currentWorkspace !== workspace() || disposed) return;
      coordinator.schedule(path);
    }).catch((error: unknown) => {
      if (epoch !== directoryRefreshEpoch || generation !== workspaceGeneration || currentWorkspace !== workspace() || disposed) return;
      setRoot((current) => updateEntry(markDirectoryStale(current, path), path, (entry) => ({ ...entry, partialError: { kind: "metadata", message: errorMessage(error, "Unable to read directory.") } })));
      notify("Unable to load workspace directory refresh.");
    });
  };

  const relistAllDirectories = () => {
    const currentWorkspace = workspace();
    if (!currentWorkspace) return;
    const expandedPaths = currentExpandedPaths();
    setRoot((current) => markAllDirectoriesStale(current));
    scheduleDirectoryRefresh(currentWorkspace);
    for (const path of expandedPaths) scheduleDirectoryRefresh(path);
  };

  const refreshRoot = async (directoryPath = workspace()) => {
    const requestWorkspace = workspace();
    const requestGeneration = workspaceGeneration;
    if (!requestWorkspace) {
      setRoot(makeRecentProjectsRoot(recentProjects()));
      return;
    }
    try {
      await refreshDirectory(directoryPath, requestGeneration);
      if (disposed || requestGeneration !== workspaceGeneration || requestWorkspace !== workspace()) return;
      await refreshGit(false, requestWorkspace);
    } catch (error) {
      if (!disposed && requestGeneration === workspaceGeneration && requestWorkspace === workspace()) {
        notify(errorMessage(error, "Unable to refresh workspace."));
      }
    }
  };

  const createPluginApiExecutor = (host: PluginHostModules, plugin: InstalledPlugin, editorRevisionTracker: PluginEditorRevisionTracker): PluginApiV2Dependencies["execute"] => async (method, params, context) => {
    const requireWorkspaceRoot = () => {
      if (!context.workspaceRoot) throw new Error("This plugin operation needs an open workspace.");
      return context.workspaceRoot;
    };
    const throwIfCancelled = () => {
      if (context.signal.aborted) throw new Error("Plugin API operation was cancelled.");
    };
    try {
      switch (method) {
        case "editor.getText": {
          const currentTab = activeTab();
          if (!currentTab) throw new Error("There is no active editor.");
          const handle = documentController.getHandle(currentTab.id);
          if ((handle?.getTextLength() ?? currentTab.content.length) > 128 * 1024) throw new host.PluginApiV2OperationError("editor.range_required", "editor.range_required");
          return handle?.getText() ?? getDocumentText(currentTab);
        }
        case "editor.getTextRange": {
          const currentTab = activeTab();
          if (!currentTab || currentTab.language === "Image") throw new host.PluginApiV2OperationError("editor.unavailable", "editor.unavailable");
          if (!editorRevisionTracker.matches(params.revision as number, currentTab.id, currentTab.revision, activeTabSelectionGeneration)) throw new host.PluginApiV2OperationError("editor.stale_revision", "editor.stale_revision");
          const handle = documentController.getHandle(currentTab.id);
          const length = handle?.getTextLength() ?? currentTab.content.length;
          const from = params.from as number;
          const to = params.to as number;
          if (from < 0 || to < from || to > length || to - from > 128 * 1024) throw new host.PluginApiV2OperationError("editor.invalid_range", "editor.invalid_range");
          return { revision: params.revision, from, to, content: handle?.getRange(from, to) ?? currentTab.content.slice(from, to) };
        }
        case "editor.getSelection": {
          const currentTab = activeTab();
          if (!currentTab) throw new Error("There is no active editor.");
          const selection = documentController.getHandle(currentTab.id)?.getSelection();
          if (!selection) throw new Error("The active editor selection is unavailable.");
          return selection;
        }
        case "editor.getCursor": {
          const currentTab = activeTab();
          if (!currentTab) throw new Error("There is no active editor.");
          const cursor = documentController.getHandle(currentTab.id)?.getCursor();
          if (!cursor) throw new Error("The active editor cursor is unavailable.");
          return cursor;
        }
        case "editor.getFileInfo": {
          const currentTab = activeTab();
          if (!currentTab) throw new Error("There is no active editor.");
          const metadata = documentController.getHandle(currentTab.id)?.getMetadata();
          return {
            path: currentTab.path,
            name: currentTab.name,
            language: currentTab.language,
            revision: editorRevisionTracker.capture(currentTab.id, currentTab.revision, activeTabSelectionGeneration),
            dirty: currentTab.dirty,
            encoding: currentTab.encoding,
            lineEnding: currentTab.lineEnding,
            size: metadata?.estimatedBytes ?? currentTab.estimatedBytes ?? currentTab.diskSize ?? utf8ByteLength(currentTab.content),
          };
        }
        case "editor.applyEdits": {
          if (appQuitPrepared() || confirmedOperationInProgress()) {
            throw new Error("Editor changes are blocked while the window is closing.");
          }
          await context.authorize();
          throwIfCancelled();
          if (appQuitPrepared() || confirmedOperationInProgress()) {
            throw new Error("Editor changes are blocked while the window is closing.");
          }
          const currentTab = activeTab();
          if (!currentTab || viewMode() !== "editor") throw new Error("There is no active editor.");
          const revision = params.revision as number;
          if (!editorRevisionTracker.matches(
            revision,
            currentTab.id,
            currentTab.revision,
            activeTabSelectionGeneration,
          )) {
            throw new Error("The active document or its revision changed; read its file information again before editing.");
          }
          const document = documentController.getHandle(currentTab.id);
          if (!document?.applyEdits(currentTab.revision, params.edits as Array<{ from: number; to: number; insert: string }>)) {
            throw new Error("The active document changed before the edit could be applied.");
          }
          const updatedTab = tabById[currentTab.id];
          return {
            applied: true,
            revision: editorRevisionTracker.capture(
              currentTab.id,
              updatedTab?.revision ?? currentTab.revision + 1,
              activeTabSelectionGeneration,
            ),
          };
        }
        case "workspace.list": {
          await context.authorize();
          throwIfCancelled();
          return pluginWorkspaceList(requireWorkspaceRoot(), (params.path as string | undefined) ?? ".");
        }
        case "workspace.readFile": {
          await context.authorize();
          throwIfCancelled();
          const root = requireWorkspaceRoot();
          const info = await pluginWorkspaceFileInfo(root, params.path as string);
          throwIfCancelled();
          if (info.sizeBytes > 128 * 1024) throw new host.PluginApiV2OperationError("workspace.file_requires_ranges", "workspace.file_requires_ranges");
          return await pluginWorkspaceReadFile(root, params.path as string);
        }
        case "workspace.getFileInfo":
          await context.authorize();
          throwIfCancelled();
          return await pluginWorkspaceFileInfo(requireWorkspaceRoot(), params.path as string);
        case "workspace.readFileRange":
          await context.authorize();
          throwIfCancelled();
          return await pluginWorkspaceReadFileRange(requireWorkspaceRoot(), params.path as string, params.revision as string, params.offsetBytes as number, params.maxBytes as number, context.nativeRequestId, context.signal);
        case "workspace.releaseFileRead":
          await context.authorize();
          throwIfCancelled();
          await pluginWorkspaceReleaseFileRead(requireWorkspaceRoot(), params.path as string, params.revision as string);
          return { released: true };
        case "workspace.writeFile": {
          await context.authorize();
          throwIfCancelled();
          return pluginWorkspaceWriteFile(
            requireWorkspaceRoot(),
            params.path as string,
            params.content as string,
            params.expectedFingerprint as string | undefined,
          );
        }
        case "commands.register":
          return { registered: true, id: params.id };
        case "ui.notify":
          notify(`${plugin.name}: ${params.message}`);
          return { shown: true };
        case "ui.statusBar.set": {
          await context.authorize();
          throwIfCancelled();
          const id = params.id as string;
          const key = pluginStatusItemKey(context.plugin.id, id);
          const current = pluginStatusItems();
          if (!current[key] && Object.values(current).filter((item) => item.pluginId === context.plugin.id).length >= 20) {
            throw new Error("This plugin has reached the status bar item limit.");
          }
          setPluginStatusItems((items) => ({
            ...items,
            [key]: {
              pluginId: context.plugin.id,
              pluginName: context.plugin.name,
              id,
              text: params.text as string,
              ...(params.tooltip === undefined ? {} : { tooltip: params.tooltip as string }),
            },
          }));
          return { set: true, id };
        }
        case "ui.statusBar.remove": {
          await context.authorize();
          throwIfCancelled();
          const key = pluginStatusItemKey(context.plugin.id, params.id as string);
          setPluginStatusItems((items) => {
            if (!items[key]) return items;
            const next = { ...items };
            delete next[key];
            return next;
          });
          return { removed: true, id: params.id };
        }
        case "ui.quickPick":
          await context.authorize();
          throwIfCancelled();
          return requestPluginQuickPick(context.plugin, params, context.signal);
        case "git.getStatus": {
          await context.authorize();
          throwIfCancelled();
          const status = await getGitStatus(requireWorkspaceRoot());
          throwIfCancelled();
          return {
            repositoryRoot: status.repositoryRoot,
            branch: status.branch,
            repositoryState: status.repositoryState,
            files: status.files,
            error: status.error,
          };
        }
        case "git.getDiff": {
          await context.authorize();
          throwIfCancelled();
          return pluginGitDiff(
            requireWorkspaceRoot(),
            params.path as string,
            params.staged === true,
          );
        }
        case "terminal.write":
          return host.writeToActivePluginTerminal(
            requireWorkspaceRoot(),
            params.data as string,
            params.binary === true,
            context.signal,
            context.authorize,
          ).then(() => ({ written: true }));
        case "network.fetch": {
          const url = new URL(params.url as string);
          const workspaceRoot = requireWorkspaceRoot();
          const method = ((params.method as string | undefined) ?? "GET").toUpperCase();
          const headers = (params.headers as Record<string, string> | undefined) ?? {};
          const body = params.body as string | undefined;
          await context.authorize();
          throwIfCancelled();
          const authorizationToken = await authorizePluginNetwork(
            context.plugin.id,
            context.plugin.version,
            workspaceRoot,
            url.hostname.toLowerCase(),
          );
          const cancelRequest = () => {
            void cancelPluginNetworkRequest(authorizationToken, workspaceRoot).catch((error) => {
              emitDiagnostic("plugin.cancel", error);
            });
          };
          if (context.signal.aborted) cancelRequest();
          else context.signal.addEventListener("abort", cancelRequest, { once: true });
          try {
            await context.authorize();
            throwIfCancelled();
            return await pluginNetworkRequest(
              authorizationToken,
              workspaceRoot,
              url.toString(),
              method,
              headers,
              body,
            );
          } finally {
            context.signal.removeEventListener("abort", cancelRequest);
          }
        }
        case "lsp.start": {
          const target = await resolvePluginLspTarget(context.plugin, context.workspaceRoot, params.serverId as string);
          await context.authorize();
          await approveLspServer({
            pluginId: context.plugin.id,
            pluginVersion: context.plugin.version,
            workspaceRoot: target.resolved.workspaceRoot,
            server: target.server,
            expectedExecutablePath: target.resolved.executablePath,
          });
          await context.authorize();
          await startLspServer({
            pluginId: context.plugin.id,
            pluginVersion: context.plugin.version,
            workspaceRoot: target.resolved.workspaceRoot,
            server: target.server,
          }, (event) => { void routeLspEvent(event); });
          return { started: true, serverId: target.server.serverId };
        }
        case "lsp.send": {
          const target = await resolvePluginLspTarget(context.plugin, context.workspaceRoot, params.serverId as string);
          await context.authorize();
          await sendLspMessage({
            pluginId: context.plugin.id,
            pluginVersion: context.plugin.version,
            workspaceRoot: target.resolved.workspaceRoot,
            language: target.server.language,
          }, params.message as Record<string, unknown>);
          return { sent: true };
        }
        case "lsp.cancel": {
          const target = await resolvePluginLspTarget(context.plugin, context.workspaceRoot, params.serverId as string);
          await context.authorize();
          await cancelLspRequest({
            pluginId: context.plugin.id,
            pluginVersion: context.plugin.version,
            workspaceRoot: target.resolved.workspaceRoot,
            language: target.server.language,
          }, params.requestId as string | number);
          return { cancelled: true };
        }
        case "lsp.stop": {
          const target = await resolvePluginLspTarget(context.plugin, context.workspaceRoot, params.serverId as string);
          await context.authorize();
          await stopLspServer({
            pluginId: context.plugin.id,
            pluginVersion: context.plugin.version,
            workspaceRoot: target.resolved.workspaceRoot,
            language: target.server.language,
          });
          return { stopped: true };
        }
      }
    } catch (error) {
      if (error instanceof host.PluginApiV2OperationError) throw error;
      const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
      const code = /^(workspace\.(?:file_too_large|file_changed|invalid_range|file_requires_ranges|read_cancelled))(?::|$)/.exec(message)?.[1];
      if (code) throw new host.PluginApiV2OperationError(code, code);
      throw error;
    }
  };

  const getPluginController = (host: PluginHostModules) => pluginController ??= host.createPluginHostController({
    pluginsRecovered, plugins, workspace, workspaceGeneration: () => workspaceGeneration,
    isDisposed: () => disposed, notify, readPluginEntry,
    getEditorText: () => { const tab = activeTab(); return tab ? getDocumentText(tab) : ""; },
    setPluginStatus: (id, status) => setPlugins((items) => items.map((item) => item.id === id ? { ...item, status } : item)),
    resolveApiPermission,
    executeApi: (plugin, revisions) => createPluginApiExecutor(host, plugin, revisions),
    readStorage, writeStorage,
    onAuthorizationChange: handleAuthorizationChange,
  });

  const runPlugin = async (plugin: InstalledPlugin, activationEvent: string, activationPayload: unknown, activationCommand?: string) => {
    const generation = workspaceGeneration;
    const host = await getPluginHostModules();
    if (disposed || generation !== workspaceGeneration) return;
    await getPluginController(host).runPlugin(plugin, activationEvent, activationPayload, activationCommand);
  };

  const activatePluginForEvent = (host: PluginHostModules, plugin: InstalledPlugin, event: string, payload: unknown) => {
    if (!pluginsRecovered()) return;
    if (!host.pluginActivationMatches(plugin, event)) return;
    const runs = pluginRunsFor(plugin.id);
    const subscribed = runs.find((run) => run.subscriptions.has(event));
    if (subscribed) {
      if (subscribed.ready) subscribed.send({ type: "host-event", event, payload });
      else subscribed.pendingActivations.push({ event, payload });
      return;
    }
    const starting = runs.find((run) => !run.ready && run.activationEvent === event && !run.activationCommand);
    if (starting) {
      starting.pendingActivations.push({ event, payload });
      return;
    }
    void runPlugin(plugin, event, payload);
  };

  const activatePluginsForEvent = (event: string, payload: unknown) => {
    if (!pluginsRecovered()) return;
    const list = plugins();
    if (!list.some((plugin) => plugin.enabled)) return;
    void getPluginHostModules().then((host) => {
      for (const plugin of list) activatePluginForEvent(host, plugin, event, payload);
    });
  };

  const routeLspEvent = async (event: LspEvent) => {
    const eventName = `lsp.${event.type}`;
    const eventWorkspaceRoot = workspace();
    const eventWorkspaceGeneration = workspaceGeneration;
    if (!pluginsRecovered() || !eventWorkspaceRoot) return;
    const plugin = plugins().find((candidate) => candidate.id === event.pluginId);
    if (!plugin?.enabled
        || plugin.apiVersion !== "2"
        || plugin.version !== event.pluginVersion) return;
    const host = await getPluginHostModules();
    if (!host.isPluginEventSubscriptionAllowed(plugin, eventName)) return;
    const server = declaredLspServer(plugin, event.serverId);
    if (!server || server.language !== event.language) return;

    let target: Awaited<ReturnType<typeof resolvePluginLspTarget>>;
    try {
      target = await resolvePluginLspTarget(plugin, eventWorkspaceRoot, event.serverId);
    } catch {
      return;
    }
    const currentPlugin = plugins().find((candidate) => candidate.id === event.pluginId);
    if (!currentPlugin?.enabled
        || currentPlugin.apiVersion !== "2"
        || currentPlugin.version !== event.pluginVersion
        || workspace() !== eventWorkspaceRoot
        || workspaceGeneration !== eventWorkspaceGeneration
        || target.resolved.workspaceRoot !== event.workspaceRoot
        || target.server.language !== event.language
        || !host.isPluginEventSubscriptionAllowed(currentPlugin, eventName)) return;
    if (!(await ensureAuthorizationManager()).hasPermission({
      plugin: currentPlugin,
      permission: "process.spawn:lsp",
      workspaceRoot: target.permissionScope.workspaceRoot,
      resourceScope: target.permissionScope.resourceScope,
    })) return;

    for (const run of pluginRunsFor(event.pluginId)) {
      if (!host.isPluginLspEventForRun(run, event, { workspaceRoot: eventWorkspaceRoot, canonicalWorkspaceRoot: target.resolved.workspaceRoot, generation: eventWorkspaceGeneration })
          || !pluginController?.isLive(run)
          || !run.subscriptions.has(eventName)) continue;
      run.send({ type: "host-event", event: eventName, payload: event });
    }
  };

  // LSP events arrive on the per-start channel passed to
  // startLspServer, so no global listener is registered here.

  const executePluginCommand = (pluginId: string, commandId: string) => {
    const list = plugins();
    if (!list.some((plugin) => plugin.enabled)) return;
    void getPluginHostModules().then((host) => {
      const event = host.commandEventName(commandId);
      const payload = { command: commandId };
      for (const plugin of list) {
        if (!plugin.enabled) continue;
        if (plugin.id === pluginId) {
          const existing = pluginRunsFor(plugin.id).find((run) => run.commands.has(commandId));
          if (existing?.ready) existing.send({ type: "command", command: commandId });
          else {
            const queued = host.queueCommandForStartingRun(pluginRunsFor(plugin.id), commandId, event, payload);
            if (!queued) void runPlugin(plugin, event, payload, commandId);
          }
        } else {
          activatePluginForEvent(host, plugin, event, payload);
        }
      }
    });
  };

  const runPaletteCommand = (command: CommandPaletteItem) => {
    setCommandPaletteOpen(false);
    if (command.source === "plugin" && command.pluginId && command.commandId) {
      executePluginCommand(command.pluginId, command.commandId);
      return;
    }
    if (plugins().some((plugin) => plugin.enabled)) {
      void getPluginHostModules().then((host) => activatePluginsForEvent(host.commandEventName(command.id), { command: command.id }));
    }
    switch (command.id) {
      case "pude.builtin.openFile": void openFileAction(); break;
      case "pude.builtin.openFolder": void loadWorkspace(); break;
      case "pude.builtin.save": void saveTab(); break;
      case "pude.builtin.saveAs": void saveTabAs(); break;
      case "pude.builtin.find": showFind(false); break;
      case "pude.builtin.replace": showFind(true); break;
      case "pude.builtin.toggleTerminal": toggleTerminal(); break;
      case "pude.builtin.managePlugins": setPluginsOpen(true); break;
    }
  };

  let activeLanguageActivationKey = "";
  createEffect(() => {
    const tab = activeTab();
    if (!hydrated() || !tab) {
      activeLanguageActivationKey = "";
      return;
    }
    if (!plugins().some((plugin) => plugin.enabled)) {
      activeLanguageActivationKey = "";
      return;
    }
    void getPluginHostModules().then((host) => {
      const language = host.activationLanguageId(fileLanguageForPath(tab.path).label);
      const key = `${tab.id}\u0000${language}`;
      if (key === activeLanguageActivationKey) return;
      activeLanguageActivationKey = key;
      const payload = { file: { path: tab.path, name: tab.name, language } };
      activatePluginsForEvent(host.languageEventName(language), payload);
    });
  });

  const resolveAuthorizationReviewManifest = async (
    manifest: PluginAuthorizationReviewManifest,
    workspaceRoot: string,
  ): Promise<PluginAuthorizationReviewManifest> => {
    if (!workspaceRoot || !manifest.lspServers?.length) return { ...manifest, resolvedLspServers: [] };
    const resolvedLspServers = await Promise.all(manifest.lspServers.map(async (server) => {
      try {
        return await resolvePluginLspServer(workspaceRoot, server);
      } catch {
        return undefined;
      }
    }));
    return { ...manifest, resolvedLspServers: resolvedLspServers.filter((server): server is NonNullable<typeof server> => server !== undefined) };
  };

  const approveLspPermissionGrant = async (
    manifest: PluginAuthorizationReviewManifest,
    request: PluginPermissionGrantRequest,
  ) => {
    const scope = request.resourceScope;
    if (request.permission !== "process.spawn:lsp" || scope?.kind !== "executable" || !request.workspaceRoot) return;
    const server = manifest.lspServers?.find((candidate) => candidate.serverId === scope.serverId
      && candidate.language === scope.language
      && JSON.stringify(candidate.args) === JSON.stringify(scope.args));
    const host = await getPluginHostModules();
    const resolved = manifest.resolvedLspServers?.find((candidate) => host.matchesResolvedPluginLspGrant(candidate, request));
    if (!server || !resolved) throw new Error(`Language server ${scope.serverId} no longer matches the reviewed executable and arguments.`);
    await approveLspServer({
      pluginId: request.pluginId,
      pluginVersion: request.pluginVersion,
      workspaceRoot: request.workspaceRoot,
      server,
      expectedExecutablePath: resolved.executablePath,
    });
  };

  const restorePluginLspAuthorizations = async (plugin: PluginAuthorizationReviewManifest, workspaceRoot: string) => {
    if (!workspaceRoot) return;
    const grants = (await ensureAuthorizationManager()).getSnapshot().grants.filter((grant) => grant.pluginId === plugin.id
      && grant.pluginVersion === plugin.version
      && grant.permission === "process.spawn:lsp"
      && grant.workspaceRoot === workspaceRoot);
    if (!grants.length) return;
    const resolvedManifest = await resolveAuthorizationReviewManifest(plugin, workspaceRoot);
    for (const grant of grants) await approveLspPermissionGrant(resolvedManifest, grant);
  };

  const restoreAllPluginLspAuthorizations = async (plugin: PluginAuthorizationReviewManifest) => {
    const workspaceRoots = new Set((await ensureAuthorizationManager()).getSnapshot().grants
      .filter((grant) => grant.pluginId === plugin.id
        && grant.pluginVersion === plugin.version
        && grant.permission === "process.spawn:lsp"
        && Boolean(grant.workspaceRoot))
      .map((grant) => grant.workspaceRoot as string));
    for (const workspaceRoot of workspaceRoots) await restorePluginLspAuthorizations(plugin, workspaceRoot);
  };

  const togglePlugin = (id: string) => {
    if (pluginOperationInFlight || !pluginsRecovered()) return;
    const plugin = plugins().find((item) => item.id === id);
    if (!plugin) return;
    const enabled = !plugin.enabled;
    if (!enabled) {
      nextPluginRunGeneration(id);
      stopPluginRun(id);
      clearPluginStatusItems(id);
      void stopPluginLsp(id).catch((error) => notify(errorMessage(error, "Unable to stop plugin language servers.")));
      void revokePluginNetwork(id).catch((error) => notify(errorMessage(error, "Unable to cancel plugin network requests.")));
      setPlugins((items) => items.map((item) => item.id === id ? { ...item, enabled: false, status: "inactive" } : item));
      return;
    }
    void (async () => {
      try {
        await restorePluginLspAuthorizations(plugin, workspace());
        setPlugins((items) => items.map((item) => item.id === id ? { ...item, enabled: true, status: "inactive" } : item));
      } catch (error) {
        notify(errorMessage(error, "Unable to restore plugin language-server approvals."));
      }
    })();
  };

  const reloadExternalFile = externalConflictController.reload;
  const compareExternalFile = externalConflictController.compare;

  const saveTabAs = async (tab = activeTab()): Promise<boolean> => {
    if (!tab || tab.language === "Image" || confirmedOperationInProgress() || appQuitPrepared()) return false;
    const sourceName = tab.name;
    const generation = workspaceGeneration;
    const sourceSnapshot = captureTabOperation(tab);
    const liveSnapshot = documentController.getHandle(tab.id)?.getSnapshot();
    const documentRevision = liveSnapshot?.revision ?? tab.revision;
    const content = liveSnapshot?.content ?? normalizeDocumentContent(getDocumentText(tab));
    const lineEndings = liveSnapshot?.lineEndings ?? normalizeLineEndingMap(content, tab.lineEndings, tab.lineEnding);
    const lineEnding = liveSnapshot?.lineEnding ?? lineEndingFromMap(lineEndings, tab.lineEnding);
    const bom = liveSnapshot?.bom ?? tab.bom === true;
    const isSourceCurrent = () => generation === workspaceGeneration
      && tabOperationIsCurrent(sourceSnapshot)
      && (documentController.getHandle(tab.id)?.getMetadata()?.revision ?? tabById[tab.id]?.revision) === documentRevision;
    const isDestinationOpen = (destination: string) => tabs().some((item) => item.id !== tab.id && samePath(item.path, destination));
    let operationLocked = false;
    try {
      const destination = await saveFileDialog(tab.name);
      if (!destination) return false;
      if (confirmedOperationInProgress() || appQuitPrepared() || !isSourceCurrent()) {
        notify("This file changed while Save As was open. Try again.");
        return false;
      }
      if (isDestinationOpen(destination)) {
        notify("That destination is already open in another tab.");
        return false;
      }
      const destinationState = await inspectSaveAsDestination(destination);
      if (confirmedOperationInProgress() || appQuitPrepared() || !isSourceCurrent() || isDestinationOpen(destination)) {
        notify("The file or destination changed while Save As was open. Try again.");
        return false;
      }
      if (destinationState.exists) {
        const confirmed = await requestConfirmation({
          title: `Overwrite ${baseName(destination)}?`,
          message: `A file named ${baseName(destination)} already exists. Replace its contents with this file?`,
          confirmLabel: "Overwrite",
          cancelLabel: "Cancel",
          destructive: true,
        });
        if (!confirmed) return false;
        if (confirmedOperationInProgress() || appQuitPrepared() || !isSourceCurrent() || isDestinationOpen(destination)) {
          notify("The file or destination changed while waiting for confirmation. Try again.");
          return false;
        }
      }
      if (confirmedOperationInProgress() || appQuitPrepared() || !isSourceCurrent() || isDestinationOpen(destination)) return false;
      setConfirmedOperationInProgress(true);
      operationLocked = true;
      const result = await saveFileAs(destination, content, lineEnding, lineEndings, bom, destinationState.token);
      const current = tabById[tab.id];
      if (!isSourceCurrent() || !current) {
        notify(`Saved a copy as ${baseName(destination)}, but the source tab changed and stayed at its original path.`);
        return false;
      }
      const nextRevision = current.revision + 1;
      updateTab(current.id, {
        path: destination,
        name: baseName(destination),
        language: fileLanguageForPath(destination).label,
        content,
        savedContent: content,
        dirty: false,
        orphaned: false,
        lineEnding,
        lineEndings,
        savedLineEndings: lineEndings,
        bom,
        savedBom: bom,
        encoding: bom ? "UTF-8 BOM" : "UTF-8",
        revision: nextRevision,
        savedRevision: nextRevision,
        normalizedContentVersion: current.contentVersion,
        normalizedSavedRevision: nextRevision,
        diskModifiedAt: result.modifiedAt,
        diskSize: result.size,
        diskFingerprint: result.fingerprint,
        diskIdentity: result.identity ?? undefined,
        largeFile: result.size > 5 * 1024 * 1024,
      });
      clearRecovery(current.id);
      externalConflictController.dismiss(current.id);
      syncExternalWatchParents();
      scheduleGitRefresh();
      if (plugins().some((plugin) => plugin.enabled)) {
        void getPluginHostModules().then((host) => activatePluginsForEvent("onFileSave", { file: { path: destination, name: baseName(destination), language: host.activationLanguageId(fileLanguageForPath(destination).label) } }));
      }
      notify(`Saved ${sourceName} as ${baseName(destination)}`);
      return true;
    } catch (error) {
      notify(errorMessage(error, "Unable to save file as the selected destination."));
      return false;
    } finally {
      if (operationLocked) setConfirmedOperationInProgress(false);
    }
  };

  const saveExternalFileAs = async (tab: EditorTab) => {
    await saveTabAs(tab);
  };

  const verifyOpenFile = (tab: EditorTab, generation: number, readRevision: number) => {
    void getSaveController().then((controller) => controller.readAfterSaves(tab.id, () => readFileWithIoLimit(tab.path))).then(normalizeReadFile).then((file) => {
      if (generation !== workspaceGeneration || fileReadRevisions.get(tab.id) !== readRevision) return;
      const current = tabById[tab.id];
      if (!current || !samePath(current.path, tab.path)) return;
      if (current.dirty) {
        if (file.content !== current.savedContent || !sameTextMetadata(file, { encoding: current.encoding === "UTF-8 BOM" ? "utf-8-bom" : "utf-8", bom: current.savedBom, lineEndings: current.savedLineEndings, lineEnding: current.lineEnding }, current.savedContent)) externalConflictController.queue(current);
        else updateTab(current.id, { orphaned: false, diskModifiedAt: file.modifiedAt, diskSize: file.size, estimatedBytes: file.size, diskFingerprint: file.fingerprint, diskIdentity: file.identity ?? undefined });
        return;
      }
      if (file.content === current.savedContent && sameTextMetadata(file, { encoding: current.encoding === "UTF-8 BOM" ? "utf-8-bom" : "utf-8", bom: current.bom, lineEndings: current.lineEndings, lineEnding: current.lineEnding }, current.savedContent)) {
        updateTab(current.id, { orphaned: false, diskModifiedAt: file.modifiedAt, diskSize: file.size, estimatedBytes: file.size, diskFingerprint: file.fingerprint, diskIdentity: file.identity ?? undefined });
        return;
      }
      const revision = current.revision + 1;
      updateTab(current.id, { content: file.content, savedContent: file.content, dirty: false, orphaned: false, lineEnding: file.lineEnding, lineEndings: file.lineEndings, savedLineEndings: file.lineEndings, bom: file.bom, savedBom: file.bom, encoding: file.encoding === "utf-8-bom" ? "UTF-8 BOM" : "UTF-8", revision, savedRevision: revision, contentVersion: current.contentVersion + 1, normalizedContentVersion: current.contentVersion + 1, normalizedSavedRevision: revision, diskModifiedAt: file.modifiedAt, diskSize: file.size, estimatedBytes: file.size, diskFingerprint: file.fingerprint, diskIdentity: file.identity ?? undefined, largeFile: file.size > 5 * 1024 * 1024 });
      getDocumentRevision(current.id).bump();
    }).catch((error) => {
      if (generation !== workspaceGeneration || fileReadRevisions.get(tab.id) !== readRevision) return;
      const current = tabById[tab.id];
      if (!current) return;
      if (isMissingFileError(error)) {
        if (current.dirty) externalConflictController.queue(current);
        else updateTab(current.id, { orphaned: true });
      } else {
        notify(errorMessage(error, `Unable to reload ${current.name}.`));
      }
    });
  };

  const verifyOpenFiles = () => {
    const generation = workspaceGeneration;
    const candidates = tabs().filter((tab) => tab.language !== "Image");
    if (!candidates.length) return;
    const readRevisions = new Map(candidates.map((tab) => [tab.id, fileReadRevisions.get(tab.id)]));
    const currentCandidate = (tab: EditorTab) => {
      const current = tabById[tab.id];
      return generation === workspaceGeneration && current && samePath(current.path, tab.path)
        && readRevisions.get(tab.id) === fileReadRevisions.get(tab.id) ? current : undefined;
    };
    const queueFullRead = (tab: EditorTab) => {
      const current = currentCandidate(tab);
      if (!current) return;
      const readRevision = (fileReadRevisions.get(tab.id) ?? 0) + 1;
      fileReadRevisions.set(tab.id, readRevision);
      versionedFileReader?.invalidate(current.path);
      verifyOpenFile(current, generation, readRevision);
    };
    // With a healthy watcher, external modifications arrive as events and are
    // verified there; a batch stat is enough here. When the watcher is
    // unavailable we may have missed events, so keep the full read.
    const watcherActive = isTauri && Boolean(watcherSessionId) && !watcherNeedsRestart;
    if (!watcherActive) {
      for (const tab of candidates) queueFullRead(tab);
      return;
    }
    void statFiles(candidates.map((tab) => tab.path)).then((entries) => {
      if (generation !== workspaceGeneration) return;
      const entryByPath = new Map(entries.map((entry) => [pathKey(entry.path), entry]));
      for (const tab of candidates) {
        const current = currentCandidate(tab);
        if (!current) continue;
        const entry = entryByPath.get(pathKey(tab.path));
        if (entry && !entry.exists) {
          queueFullRead(tab);
          continue;
        }
        if (diskMetadataChanged(current, entry)) queueFullRead(tab);
      }
    }).catch(() => {
      for (const tab of candidates) queueFullRead(tab);
    });
  };

  const openPluginAuthorizationReview = async (targetPluginId?: string) => {
    if (!pluginsRecovered()) {
      notify("Installed plugin state could not be verified; plugin changes are temporarily unavailable.");
      return;
    }
    if (pluginOperationInFlight) return;
    pluginOperationInFlight = true;
    let plan: PluginInstallPlan | null = null;
    try {
      plan = await inspectPluginInstall();
      if (!plan) {
        notify("Local plugin installation is available in the desktop build.");
        return;
      }
      const existing = plugins().find((plugin) => plugin.id === plan!.manifest.id);
      if (plan.installedManifest && plan.manifest.id !== plan.installedManifest.id) {
        throw new Error("The selected plugin does not match the installed plugin being updated.");
      }
      if (targetPluginId && (plan.manifest.id !== targetPluginId || plan.installedManifest?.id !== targetPluginId || !existing)) {
        await cancelPluginInstall(plan.transactionId);
        plan = null;
        notify("The selected folder contains a different plugin. The update was cancelled.");
        return;
      }
      if (!plan.installedManifest && existing) {
        await cancelPluginInstall(plan.transactionId);
        plan = null;
        notify("The installed plugin changed while the folder was being inspected. Try again.");
        return;
      }
      let workspaceRoot = workspace();
      if (workspaceRoot) workspaceRoot = await canonicalizeWorkspaceRoot(workspaceRoot);
      const proposed = await resolveAuthorizationReviewManifest(plan.manifest, workspaceRoot);
      const current = plan.installedManifest
        ? await resolveAuthorizationReviewManifest(plan.installedManifest, workspaceRoot)
        : undefined;
      setPluginsOpen(false);
      setAuthorizationReview({
        plan,
        proposed,
        current,
        workspaceRoot,
        wasEnabled: existing?.enabled ?? false,
      });
    } catch (error) {
      if (plan) {
        try {
          await cancelPluginInstall(plan.transactionId);
        } catch (cancelError) {
          emitDiagnostic("plugin.cancel", cancelError);
        }
      }
      notify(errorMessage(error, "Unable to inspect the selected plugin folder."));
    } finally {
      pluginOperationInFlight = false;
    }
  };

  const cancelPluginAuthorizationReview = async () => {
    if (pluginOperationInFlight) return;
    const review = authorizationReview();
    setAuthorizationReview(undefined);
    setPluginsOpen(true);
    if (!review) return;
    try {
      await cancelPluginInstall(review.plan.transactionId);
    } catch (error) {
      notify(errorMessage(error, "Unable to discard the inspected plugin."));
    }
  };

  const approvePluginAuthorizationReview = async (requests: PluginPermissionGrantRequest[]) => {
    const review = authorizationReview();
    if (!review || pluginOperationInFlight) return;
    pluginOperationInFlight = true;
    const { plan, proposed, wasEnabled, workspaceRoot } = review;
    let committedPlugin: InstalledPlugin | undefined;
    let committed = false;
    const nativeLspApprovals: PluginPermissionGrantRequest[] = [];
    let failureMessage = "Unable to install the selected plugin.";
    try {
      const validRequests = requests.filter((request) => request.pluginId === proposed.id && request.pluginVersion === proposed.version);
      if (validRequests.length !== requests.length) throw new Error("Permission review does not match the inspected plugin version.");
      if (workspaceRoot !== workspace()) throw new Error("The workspace changed during permission review. Review the plugin again before approving.");
      if (plan.installedManifest && plan.manifest.id !== plan.installedManifest.id) {
        throw new Error("The inspected update no longer matches the installed plugin.");
      }
      if (plan.installedManifest) {
        nextPluginRunGeneration(proposed.id);
        stopPluginRun(proposed.id);
        clearPluginStatusItems(proposed.id);
        setPlugins((items) => items.map((plugin) => plugin.id === proposed.id ? { ...plugin, status: "inactive" } : plugin));
        await stopPluginLsp(proposed.id);
        await revokePluginNetwork(proposed.id);
      }

      const result = await commitPluginInstall(plan.transactionId);
      committed = true;
      committedPlugin = result.plugin;

      for (const request of validRequests) {
        if (request.permission !== "process.spawn:lsp") continue;
        await approveLspPermissionGrant(proposed, request);
        nativeLspApprovals.push(request);
      }
      if (!(await ensureAuthorizationManager()).replacePluginGrants(proposed.id, proposed.version, validRequests)) {
        throw new Error("Plugin permission approvals could not be saved. The plugin was rolled back.");
      }

      if (result.cleanupPending) {
        setPendingCleanupIds((ids) => ids.includes(proposed.id) ? ids : [...ids, proposed.id]);
      }
      const installed = { ...result.plugin, enabled: wasEnabled, status: "inactive" as const };
      setPlugins((items) => items.some((plugin) => plugin.id === installed.id)
        ? items.map((plugin) => plugin.id === installed.id ? installed : plugin)
        : [...items, installed]);
      setAuthorizationReview(undefined);
      setPluginsOpen(true);
      notify(`${plan.installedManifest ? "Updated" : "Installed"} ${installed.name}. Review granted permissions before use.`);
      if (wasEnabled && workspace()) activatePluginsForEvent("onWorkspaceOpen", { workspace: workspace() });
    } catch (error) {
      failureMessage = errorMessage(error, failureMessage);
      for (const request of nativeLspApprovals) {
        const scope = request.resourceScope;
        if (scope?.kind !== "executable" || !request.workspaceRoot) continue;
        try {
          await revokeLspServer({
            pluginId: request.pluginId,
            pluginVersion: request.pluginVersion,
            workspaceRoot: request.workspaceRoot,
            server: { serverId: scope.serverId, language: scope.language, executable: scope.executablePath, args: [...scope.args] },
          });
        } catch (revokeError) {
          emitDiagnostic("plugin.failure", revokeError);
        }
      }
      if (committed) {
        if (plan.installedManifest) {
          try {
            const rolledBack = await rollbackPluginUpdate(proposed.id);
            const restored = { ...rolledBack, enabled: wasEnabled, status: "inactive" as const };
            setPlugins((items) => items.some((plugin) => plugin.id === restored.id)
              ? items.map((plugin) => plugin.id === restored.id ? restored : plugin)
              : [...items, restored]);
            if (wasEnabled) await restoreAllPluginLspAuthorizations(restored);
          } catch (rollbackError) {
            if (committedPlugin) {
              setPlugins((items) => items.some((plugin) => plugin.id === committedPlugin!.id)
                ? items.map((plugin) => plugin.id === committedPlugin!.id ? { ...committedPlugin!, enabled: false, status: "inactive" } : plugin)
                : [...items, { ...committedPlugin!, enabled: false, status: "inactive" }]);
            }
            failureMessage += ` Rollback also failed: ${errorMessage(rollbackError, "unknown error")}`;
          }
        } else {
          try {
            const removed = await uninstallPlugin(proposed.id);
            if (removed.cleanupPending) setPendingCleanupIds((ids) => ids.includes(proposed.id) ? ids : [...ids, proposed.id]);
          } catch (rollbackError) {
            if (committedPlugin) {
              setPlugins((items) => items.some((plugin) => plugin.id === committedPlugin!.id)
                ? items.map((plugin) => plugin.id === committedPlugin!.id ? { ...committedPlugin!, enabled: false, status: "inactive" } : plugin)
                : [...items, { ...committedPlugin!, enabled: false, status: "inactive" }]);
            }
            failureMessage += ` Cleanup also failed: ${errorMessage(rollbackError, "unknown error")}`;
          }
        }
      } else {
        if (plan.installedManifest) {
          try {
            await restoreAllPluginLspAuthorizations(plan.installedManifest);
          } catch (restoreError) {
            failureMessage += ` Previous language-server approvals could not be restored: ${errorMessage(restoreError, "unknown error")}`;
          }
        }
        try {
          await cancelPluginInstall(plan.transactionId);
        } catch (cancelError) {
          emitDiagnostic("plugin.cancel", cancelError);
        }
      }
      setAuthorizationReview(undefined);
      setPluginsOpen(true);
      notify(failureMessage);
    } finally {
      pluginOperationInFlight = false;
    }
  };

  const installLocalPlugin = () => void openPluginAuthorizationReview();
  const updateLocalPlugin = (id: string) => void openPluginAuthorizationReview(id);

  const uninstallLocalPlugin = async (id: string) => {
    const plugin = plugins().find((item) => item.id === id);
    if (!plugin || pluginOperationInFlight || !pluginsRecovered()) return;
    const confirmed = await requestConfirmation({
      title: `Uninstall ${plugin.name}?`,
      message: "Its saved permissions will also be removed.",
      confirmLabel: "Uninstall",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!confirmed) return;
    const currentPlugin = plugins().find((item) => item.id === id);
    if (pluginOperationInFlight || !currentPlugin || currentPlugin.version !== plugin.version) {
      notify("The plugin changed while waiting for confirmation. Try again.");
      return;
    }
    setConfirmedOperationInProgress(true);
    pluginOperationInFlight = true;
    try {
      const result = await (await getPluginHostModules()).runPluginUninstallLifecycle({
        disableAndPersistPlugin: () => {
          nextPluginRunGeneration(id);
          stopPluginRun(id);
          clearPluginStatusItems(id);
          const disabledPlugins = plugins().map((item) => item.id === id
            ? { ...item, enabled: false, status: "inactive" as const }
            : item);
          setPlugins(disabledPlugins);
          const persistedPlugins = disabledPlugins.map((item) => ({ ...item, status: "inactive" as const }));
          return writeStorage(PLUGINS_STORAGE_KEY, JSON.stringify(persistedPlugins));
        },
        revokeAuthorizations: async () => (await ensureAuthorizationManager()).revokePlugin(id),
        stopPluginRuntime: async () => {
          await Promise.all([stopPluginLsp(id), revokePluginNetwork(id)]);
        },
        uninstallNative: () => uninstallPlugin(id),
      });
      if (result.status === "blocked") {
        notify(result.reason === "plugin-state-storage-failed"
          ? "Plugin is disabled for this session, but its disabled state could not be saved. Uninstall was cancelled."
          : "Plugin is disabled, but its permissions could not be removed from storage. Uninstall was cancelled.");
        return;
      }
      if (result.cleanupPending) setPendingCleanupIds((ids) => ids.includes(id) ? ids : [...ids, id]);
      if (result.status === "removed") {
        setPlugins((items) => items.filter((item) => item.id !== id));
        notify(`Uninstalled ${plugin.name}.`);
      } else {
        notify(`Could not uninstall ${plugin.name}. It is disabled; you can retry the uninstall.`);
      }
    } catch (error) {
      notify(errorMessage(error, `Unable to uninstall ${plugin.name}.`));
    } finally {
      pluginOperationInFlight = false;
      setConfirmedOperationInProgress(false);
    }
  };

  const retryLocalPluginCleanup = async (id: string) => {
    if (!pluginsRecovered()) return;
    try {
      const cleanupPending = await retryPluginCleanup(id);
      if (cleanupPending) notify("Some plugin files still cannot be removed.");
      else {
        setPendingCleanupIds((ids) => ids.filter((pendingId) => pendingId !== id));
        notify("Plugin cleanup completed.");
      }
    } catch (error) {
      notify(errorMessage(error, "Unable to retry plugin cleanup."));
    }
  };

  const managePluginPermissions = () => {
    setPluginsOpen(false);
    setAuthorizationManagementOpen(true);
  };

  const revokePluginPermission = (grantId: string) => {
    void ensureAuthorizationManager().then((manager) => {
      if (!manager.revoke(grantId)) notify("Permission could not be revoked because authorization storage is unavailable.");
    });
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) {
      openFolderChord = null;
      return;
    }
    if (isImeComposing(event)) {
      openFolderChord = null;
      return;
    }
    if (confirmedOperationInProgress() || appQuitPrepared()) {
      openFolderChord = null;
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest(".modal, .settings-dialog, .terminal-pane")) {
      openFolderChord = null;
      return;
    }
    if (event.key === "Escape" && (tabMenu() || fileMenu())) {
      event.preventDefault();
      openFolderChord = null;
      const focusTarget = contextMenuFocusTarget;
      contextMenuFocusTarget = undefined;
      closeContextMenus();
      if (focusTarget?.isConnected) window.requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
      return;
    }
    if (event.key === "Escape" && topbarMenu()) {
      setTopbarMenu(undefined);
      openFolderChord = null;
      return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      openFolderChord = null;
      setCommandPaletteOpen(true);
      return;
    }
    if (modifier && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f" && workspace()) {
      event.preventDefault();
      openFolderChord = null;
      setSidebarView("explorer");
      setProjectSearchOpen(true);
      queueMicrotask(() => document.querySelector<HTMLInputElement>(".project-search-input input")?.focus());
      return;
    }
    if (historyViewActive() && modifier && !event.altKey) {
      const historyKey = event.key.toLowerCase();
      if (historyKey === "w" || historyKey === "s" || historyKey === "f" || historyKey === "h" || historyKey === "g") {
        event.preventDefault();
        openFolderChord = null;
        if (historyKey === "w") closeHistoryTab();
        if (historyKey === "f") findAction();
        return;
      }
    }
    const isEditorContent = Boolean(target?.closest(".cm-content"));
    if (!isEditorContent && (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT")) {
      openFolderChord = null;
      return;
    }
    const chord = advanceOpenFolderChord(openFolderChord, event, windowPlatform);
    openFolderChord = chord.state;
    if (chord.consume) {
      event.preventDefault();
      if (chord.action === "open") void loadWorkspace();
      return;
    }
    if (!modifier) return;
    const key = event.key.toLowerCase();
    if (key === "s") { event.preventDefault(); void (event.shiftKey ? saveTabAs() : event.altKey ? saveAll() : saveTab()); }
    if (key === "o" && !event.altKey) { event.preventDefault(); void openFileAction(); }
    if (key === "w") { event.preventDefault(); const id = activeTabId(); if (id) closeTab(id); }
    if (key === "f" && isMacPlatform() && event.altKey) { event.preventDefault(); showFind(true); }
    else if (key === "f" && !event.altKey) { event.preventDefault(); showFind(false); }
    if (key === "h" && !isMacPlatform() && !event.altKey) { event.preventDefault(); showFind(true); }
    if (key === "g") { event.preventDefault(); void goToLineAction(); }
    if (event.key === "Tab") { event.preventDefault(); cycleTab(event.shiftKey ? -1 : 1); }
  };

  const handleTerminalShortcut = (event: KeyboardEvent) => {
    if (isImeComposing(event) || confirmedOperationInProgress() || appQuitPrepared()) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || (event.key !== "`" && event.key !== "~")) return;
    if ((event.target as HTMLElement | null)?.closest(".modal, .settings-dialog, .command-palette")) return;
    event.preventDefault();
    event.stopPropagation();
    openFolderChord = null;
    toggleTerminal();
  };

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keydown", handleTerminalShortcut, true);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keydown", handleTerminalShortcut, true);
  });
  const closeContextMenus = () => {
    closeTabMenu();
    closeFileMenu();
    setTopbarMenu(undefined);
  };
  onMount(() => window.addEventListener("click", closeContextMenus));
  onCleanup(() => window.removeEventListener("click", closeContextMenus));

  onMount(() => {
    const flushPendingRecovery = () => {
      if (!recoveryScheduler.pendingTabs().length) return;
      recoveryScheduler.flush((tabId) => persistRecovery(tabId));
      void flushRecoveryWrites().catch((error) => emitDiagnostic("recovery.flush", error));
    };
    const flushBeforeBackground = () => {
      if (document.visibilityState === "hidden") flushPendingRecovery();
    };
    document.addEventListener("visibilitychange", flushBeforeBackground);
    window.addEventListener("pagehide", flushPendingRecovery);
    window.addEventListener("blur", flushPendingRecovery);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", flushBeforeBackground);
      window.removeEventListener("pagehide", flushPendingRecovery);
      window.removeEventListener("blur", flushPendingRecovery);
    });
    // A single throttled handler for focus and visibility resumes.
    // focus + visibilitychange often fire together; collapse them into one
    // refresh and allow at most one refresh per second.
    const refreshAfterFocusResume = () => {
      if (document.visibilityState !== "visible" || disposed) return;
      const now = Date.now();
      if (now - lastFocusResumeRefreshAt < 1000) return;
      lastFocusResumeRefreshAt = now;
      if (watcherNeedsRestart || !watcherSessionId) void restartWatcher();
      verifyOpenFiles();
      scheduleGitRefresh();
      // Directory listings are kept current by watcher events. Only relist
      // everything when the watcher is unavailable and changes may have been
      // missed.
      if (!watcherSessionId || watcherNeedsRestart) relistAllDirectories();
    };
    window.addEventListener("focus", refreshAfterFocusResume);
    document.addEventListener("visibilitychange", refreshAfterFocusResume);
    onCleanup(() => {
      window.removeEventListener("focus", refreshAfterFocusResume);
      document.removeEventListener("visibilitychange", refreshAfterFocusResume);
    });
  });

  const closeTabGroup = async (ids: string[]) => {
    const targets = tabs().filter((tab) => ids.includes(tab.id));
    const requestGeneration = workspaceGeneration;
    const snapshots = targets.map(captureTabOperation);
    if (targets.some((tab) => tab.dirty)) {
      const confirmed = await requestConfirmation({
        title: "Close selected tabs?",
        message: "One or more selected files have unsaved changes. Close them and discard those changes?",
        confirmLabel: "Close and discard",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) return;
      if (requestGeneration !== workspaceGeneration || !tabOperationsAreCurrent(snapshots)) {
        notify("One or more selected files changed while waiting for confirmation. They stayed open.");
        return;
      }
    }
    if (requestGeneration !== workspaceGeneration || !tabOperationsAreCurrent(snapshots)) return;
    const remaining = tabs().filter((tab) => !ids.includes(tab.id));
    targets.forEach((tab) => setLastClosedTab({ ...tab, content: getDocumentText(tab) }));
    setTabs(remaining);
    for (const tab of targets) {
      clearRecovery(tab.id);
      documentController.release(tab.id);
    }
    if (ids.includes(activeTabId() ?? "")) setActiveTab(remaining[0]?.id);
    markSessionDirty();
    syncExternalWatchParents();
    targets.forEach((tab) => externalConflictController.dismiss(tab.id));
    setTabMenu(undefined);
  };

  const closeOthers = (id: string) => closeTabGroup(tabs().filter((tab) => tab.id !== id).map((tab) => tab.id));
  const closeToRight = (id: string) => {
    const index = tabs().findIndex((tab) => tab.id === id);
    closeTabGroup(index < 0 ? [] : tabs().slice(index + 1).map((tab) => tab.id));
  };

  const reorderTab = (targetId: string) => {
    const sourceId = draggedTabId();
    if (!sourceId || sourceId === targetId) return;
    const items = [...tabs()];
    const sourceIndex = items.findIndex((tab) => tab.id === sourceId);
    const targetIndex = items.findIndex((tab) => tab.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = items.splice(sourceIndex, 1);
    items.splice(targetIndex, 0, moved);
    setTabs(items);
    markSessionDirty();
    setDraggedTabId(undefined);
  };

  const toggleTabPinned = (id: string) => {
    const target = tabById[id];
    if (!target) return;
    setTabs(tabs().map((tab) => tab.id === id ? { ...tab, pinned: !tab.pinned } : tab));
    markSessionDirty();
    setTabMenu(undefined);
  };

  const handleDocumentChange = ({ tabId, revision, dirty, lineEnding, estimatedBytes, largeFile }: EditorDocumentChange) => {
    const tab = tabById[tabId];
    if (!tab) return;
    // The editor owns the document text; App only tracks the small metadata
    // needed for dirty state, recovery, and saving. Full text is read on
    // demand through the document handle snapshot interface.
    updateTab(tabId, { lineEnding, revision, dirty, estimatedBytes, largeFile });
    getDocumentRevision(tabId).bump();
    scheduleRecovery(tabId);
    scheduleDocumentCacheBudget();
  };

  const selectTopbarAction = (action: () => void) => {
    setTopbarMenu(undefined);
    action();
  };
  const statusTab = () => historyViewActive() ? undefined : activeTab();
  const windowControls = () => <WindowControls
    maximized={windowMaximized()}
    onClose={() => void closeWindow("preserve")}
    onMinimize={() => { if (isTauri) void getWindowApi().then(({ getCurrentWindow }) => getCurrentWindow().minimize()); }}
    onMaximize={() => void toggleWindowMaximize()}
  />;

  return (
    <div class="app-shell" inert={appQuitPrepared() || confirmedOperationInProgress()}>
      <header class="topbar" data-platform={windowPlatform} onMouseDown={startWindowDrag}>
        <div class="brand-lockup"><img class="brand-logo" src="/pude-logo.webp" width="36" height="36" alt="pude" /></div>
        <nav class="topbar-actions" aria-label="Application menu">
          <TopbarMenu label="File" open={topbarMenu() === "file"} onToggle={() => setTopbarMenu((current) => current === "file" ? undefined : "file")}>
            <TopbarMenuItem icon="external" label="New window" onSelect={() => selectTopbarAction(() => void openNewWindowAction())} />
            <TopbarMenuItem icon="folder-open" label="Open folder" onSelect={() => selectTopbarAction(() => void loadWorkspace())} />
            <TopbarMenuItem icon="file" label="Open file" shortcut={`${shortcutModifier()}+O`} onSelect={() => selectTopbarAction(() => void openFileAction())} />
            <div class="topbar-menu-divider" />
            <TopbarMenuItem icon="save" label="Save" shortcut={`${shortcutModifier()}+S`} onSelect={() => selectTopbarAction(() => { if (!historyViewActive()) void saveTab(); })} />
            <TopbarMenuItem icon="save" label="Save As" shortcut={`${shortcutModifier()}+Shift+S`} onSelect={() => selectTopbarAction(() => { if (!historyViewActive()) void saveTabAs(); })} />
          </TopbarMenu>
          <TopbarMenu label="Edit" triggerRef={(element) => { editMenuTrigger = element; }} open={topbarMenu() === "edit"} onToggle={() => setTopbarMenu((current) => current === "edit" ? undefined : "edit")}>
          <TopbarMenuItem icon="search" label="Find" shortcut={`${shortcutModifier()}+F`} onSelect={() => selectTopbarAction(findAction)} />
          <TopbarMenuItem icon="search" label="Replace" shortcut={isMacPlatform() ? "Cmd+Option+F" : "Ctrl+H"} onSelect={() => selectTopbarAction(() => showFind(true))} />
            <TopbarMenuItem icon="command" label="Commands" shortcut={`${shortcutModifier()}+Shift+P`} onSelect={() => selectTopbarAction(() => setCommandPaletteOpen(true))} />
          </TopbarMenu>
          <TopbarMenu label="View" triggerRef={(element) => { viewMenuTrigger = element; }} open={topbarMenu() === "view"} onToggle={() => setTopbarMenu((current) => current === "view" ? undefined : "view")}>
            <TopbarMenuItem icon="plugin" label="Plugins" onSelect={() => selectTopbarAction(() => setPluginsOpen(true))} />
            <TopbarMenuItem icon="settings" label="Settings" onSelect={() => selectTopbarAction(() => setSettingsOpen(true))} />
          </TopbarMenu>
          <TopbarMenu label="Help" open={topbarMenu() === "help"} triggerRef={(element) => { helpMenuTrigger = element; }} onToggle={() => setTopbarMenu((current) => current === "help" ? undefined : "help")}>
            <TopbarMenuItem icon="external" label={["available", "downloading", "ready"].includes(updateStatus().phase) ? "About pude · Update available" : "About pude"} onSelect={() => selectTopbarAction(() => setAboutOpen(true))} />
          </TopbarMenu>
        </nav>
        <LazyProjectTabs projects={projectTabItems()} activeId={activeProjectId()} busy={!hydrated() || confirmedOperationInProgress() || appQuitPrepared() || projectCloseBusy()}
          onSelect={selectProject} onClose={requestCloseProject} onAdd={() => void addProjectTab()}
          onReorder={(source, target) => { setProjects((items) => reorderProjects(items, source, target)); markSessionDirty(); }} />
        <button class="theme-button header-theme-button" onClick={() => updateSettings({ theme: settings().theme === "dark" ? "light" : "dark" })} title={settings().theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} aria-label={settings().theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}><Icon name={settings().theme === "dark" ? "sun" : "moon"} size={16} /></button>
        <Show when={windowPlatform !== "mac"}>{windowControls()}</Show>
      </header>
      <Show when={settingsOpen()}>
        <LazySettingsDialog settings={settings()} onChange={updateSettings} onClose={() => setSettingsOpen(false)} returnFocus={() => viewMenuTrigger} />
      </Show>
      <Show when={aboutOpen()}>
        <LazyAboutDialog
          version={appVersion}
          returnFocus={() => helpMenuTrigger}
          onClose={() => setAboutOpen(false)}
        />
      </Show>

      <div class="main-layout" id="project-workspace-panel" role="tabpanel" aria-labelledby={activeProjectId() ? `project-tab-${activeProjectId()}` : undefined} style={{ "--sidebar-width": `${settings().sidebarWidth}px` }}>
        <aside class="sidebar">
           <div class="sidebar-header"><SidebarTabs selected={sidebarView()} onSelect={setSidebarView} /><Show when={sidebarView() === "explorer" && workspace()}><div class="sidebar-create-actions"><button class="icon-button" classList={{ "sidebar-search-active": projectSearchOpen() }} onClick={() => setProjectSearchOpen((open) => !open)} title="Search project (Ctrl/Cmd+Shift+F)" aria-label="Search project" aria-pressed={projectSearchOpen()}><Icon name="search" size={14} /></button><button class="icon-button" onClick={() => void contextAction("new-file", root())} title="New file" aria-label="New file"><Icon name="plus" size={14} /></button><button class="icon-button sidebar-new-folder" onClick={() => void contextAction("new-folder", root())} title="New folder" aria-label="New folder"><Icon name="folder" size={14} /></button></div></Show></div>
           <div role="tabpanel" id={SIDEBAR_EXPLORER_PANEL_ID} aria-labelledby={SIDEBAR_EXPLORER_TAB_ID} hidden={sidebarView() !== "explorer"}>
             <Show when={sidebarView() === "explorer"}>
               <Show when={workspace() && root().path !== "pude://recent-projects"} fallback={
                 <div class="explorer-scroll" role="tree" aria-label="Recent projects">
                 <Show when={recentProjectEntries().length} fallback={<div class="recent-empty">No recent projects</div>}>
                   <Suspense fallback={<div class="recent-empty" aria-busy="true" />}>
                     <LazyRecentProjectsList entries={recentProjectEntries()} onOpen={(entry) => void openEntry(entry)} />
                   </Suspense>
                 </Show>
                 </div>
               }>
                 <Show when={projectSearchOpen()} fallback={
                 <div class="explorer-scroll">
                   <Suspense fallback={<div aria-busy="true" aria-label="Loading workspace files" />}>
                     <LazyExplorer groupIgnored={settings().groupGitIgnoredFiles} ignoredPaths={gitIgnoredPaths()} ignoredExpanded={gitIgnoredExpanded()} onToggleIgnored={() => setGitIgnoredExpanded((expanded) => !expanded)} root={root()} repositoryRoot={git().repositoryRoot} activePath={activeTab()?.path} gitFiles={git().files} hideDotFiles={settings().hideDotFiles} onToggle={(entry) => void toggleDirectory(entry)} onOpen={(entry) => void openEntry(entry)} onContextMenu={showFileContextMenu} />
                   </Suspense>
                 </div>
                 }>
                   <Suspense fallback={<div aria-busy="true" aria-label="Loading project search" />}>
                     <LazyProjectSearch workspace={workspace()} onOpen={openProjectSearchResult} onClose={() => { setProjectSearchOpen(false); queueMicrotask(() => document.querySelector<HTMLButtonElement>('.sidebar-create-actions [aria-label="Search project"]')?.focus()); }} />
                   </Suspense>
                 </Show>
               </Show>
             </Show>
           </div>
           <div role="tabpanel" id={SIDEBAR_GIT_PANEL_ID} aria-labelledby={SIDEBAR_GIT_TAB_ID} hidden={sidebarView() !== "git"}>
             <Show when={sidebarView() === "git"}><LazyGitPanel status={git()} branches={gitBranches()} historyLoading={gitHistoryLoading()} historyIncomplete={gitHistoryIncomplete()} historyHasMore={gitHistoryHasMore()} historyLoadingMore={gitHistoryLoadingOlder()} onLoadMoreHistory={() => void loadOlderGitHistory()} onLoadHistory={() => void loadGitHistory()} onOpenHistory={openHistoryTab} onRefreshHistory={() => void refreshGitHistory()} onOpenDiff={(file, staged, untrackedHint) => void openDiff(file, staged, untrackedHint)} onOpenCommitDiff={(commit, file) => void openCommitDiff(commit, file)} onLoadCommitFiles={(commit) => getGitCommitFiles(workspace(), commit.hash)} onAction={(request) => runGitAction(request)} onCreateWorktree={(branchName, path, startPoint) => createGitWorktree(workspace(), branchName, path, startPoint).then((result) => notify(`Created worktree ${result.branch}; opened ${result.path} in a new window.`))} /></Show>
           </div>
            <div class="sidebar-footer"><Show when={sidebarView() === "explorer" && workspace()}><label class="sidebar-ignored-toggle" title="Group Git ignored files in Explorer"><input type="checkbox" aria-label="Group Git ignored files" checked={settings().groupGitIgnoredFiles} onChange={(event) => updateSettings({ groupGitIgnoredFiles: event.currentTarget.checked })} />Group ignored</label></Show><button class="sidebar-footer-button" onClick={() => setPluginsOpen(true)}><Icon name="plugin" size={12} /> {plugins().length} {plugins().length === 1 ? "plugin" : "plugins"}</button></div>
         </aside>
         <div class="sidebar-resizer" role="separator" aria-orientation="vertical" aria-valuemin="215" aria-valuemax="520" aria-valuenow={settings().sidebarWidth} aria-label="Resize sidebar" onPointerDown={startSidebarResize} onKeyDown={nudgeSidebarWidth} tabIndex={0} />

         <main class="workbench">
          <div class="tabbar">
            <WorkbenchTabs tabs={tabs()} activeTabId={activeTabId()} historyTabOpen={historyTabOpen()} historySelected={historyViewActive()}
              onSelectTab={(id) => { if (historyViewActive()) { diffRequestVersion += 1; setDiff(undefined); } setActiveTab(id); markSessionDirty(); setDiffReturnToHistory(false); setViewMode("editor"); }}
              onSelectHistory={() => { diffRequestVersion += 1; setDiffReturnToHistory(false); setDiff(undefined); setViewMode("history"); }}
              onCloseTab={closeTab} onCloseHistory={closeHistoryTab} onDragStart={setDraggedTabId} onDragEnd={() => setDraggedTabId(undefined)} onDrop={reorderTab}
              onContextMenu={(id, event, button) => { contextMenuFocusTarget = button; setTabMenu({ id, x: event.clientX, y: event.clientY }); }} />
            <div class="tabbar-actions">
              <button class="icon-button tabbar-action" onClick={reopenClosedTab} title="Reopen closed tab"><Icon name="arrow-up" size={13} /></button>
              <button class="icon-button tabbar-action" onClick={toggleTerminal} title="Toggle terminal"><Icon name="terminal" size={14} /></button>
            </div>
          </div>
           <Show when={tabMenu()}>{(menu) => <div class="tab-context-menu" style={{ left: `${menu().x}px`, top: `${menu().y}px` }} onClick={(event) => event.stopPropagation()}><button onClick={() => toggleTabPinned(menu().id)}><Icon name="lock" size={13} /> {tabById[menu().id]?.pinned ? "Unpin" : "Pin"}</button><Show when={tabById[menu().id]?.language !== "Image"}><button onClick={() => { const target = tabById[menu().id]; closeTabMenu(); if (target) void saveTabAs(target); }}><Icon name="save" size={13} /> Save As…</button></Show><button onClick={() => { void closeTab(menu().id); closeTabMenu(); }}><Icon name="close" size={13} /> Close</button><button onClick={() => { void closeOthers(menu().id); closeTabMenu(); }}><Icon name="split" size={13} /> Close others</button><button onClick={() => { void closeToRight(menu().id); closeTabMenu(); }}><Icon name="arrow-down" size={13} /> Close to right</button></div>}</Show>
           <Show when={fileMenu()}>{(menu) => <LazyFileContextMenu entry={menu().entry} x={menu().x} y={menu().y}
             showRelativePath={Boolean(workspace() && relativePathWithinRoot(menu().entry.path, workspace()) !== null)} revealLabel={isMacPlatform() ? "Reveal in Finder" : "Open in File Explorer"}
             onAction={(action) => { const entry = menu().entry; closeFileMenu(); void contextAction(action, entry); }}
             onCopyPath={(relative) => void copyEntryPath(menu().entry, relative)} onOpenTerminal={() => openInIntegratedTerminal(menu().entry)} onReveal={() => void openInFileExplorer(menu().entry)} />}</Show>
          <Show when={searchOpen() && !historyViewActive()}>
            <div class="findbar">
              <div class="findbar-input-wrap"><Icon name="search" size={14} /><input ref={(element) => { findInputRef = element; }} class="find-input" autocorrect="off" autocapitalize="off" spellcheck={false} value={search().query} onInput={(event) => updateSearch({ query: event.currentTarget.value })} onKeyDown={(event) => { if (event.key === "Enter") requestFind("find"); if (event.key === "Escape") setSearchOpen(false); }} placeholder="Find in file" aria-label="Find in file" /><Show when={search().query}><span class="find-count">local</span></Show></div>
              <Show when={replaceOpen()}><input ref={(element) => { replaceInputRef = element; }} class="replace-input" autocorrect="off" autocapitalize="off" spellcheck={false} value={search().replace} onInput={(event) => updateSearch({ replace: event.currentTarget.value })} placeholder="Replace" aria-label="Replace" /></Show>
              <button classList={{ "find-option": true, "find-option-active": search().caseSensitive }} onClick={() => updateSearch({ caseSensitive: !search().caseSensitive })}>Aa</button>
              <button classList={{ "find-option": true, "find-option-active": search().wholeWord }} onClick={() => updateSearch({ wholeWord: !search().wholeWord })}>ab</button>
              <button classList={{ "find-option": true, "find-option-active": search().regexp }} onClick={() => updateSearch({ regexp: !search().regexp })}>.*</button>
              <button class="find-action" onClick={() => requestFind("find")} title="Find next"><Icon name="arrow-down" size={14} /></button>
              <Show when={replaceOpen()}><button class="find-action" onClick={() => requestFind("replace")} title="Replace"><Icon name="replace" size={14} /></button><button class="find-action" onClick={() => requestFind("replaceAll")} title="Replace all"><span class="replace-all-label">All</span></button></Show>
              <button class="find-action" onClick={() => setSearchOpen(false)} title="Close find"><Icon name="close" size={14} /></button>
            </div>
          </Show>
          <div class="editor-stage">
            <div class="editor-document-panel" role="tabpanel" id={WORKBENCH_EDITOR_PANEL_ID} aria-labelledby={activeTabId() ? workbenchTabId(activeTabId()!) : undefined} aria-label={!activeTabId() ? "Editor" : undefined} hidden={viewMode() === "history"}>
            <Show when={activeTab()?.language !== "Image" ? activeTab() : undefined}>{(tab) => <div classList={{ "editor-slot": true, "editor-slot-hidden": viewMode() !== "editor" || isMarkdownPreview() }}>
              <LazyEditorPane tab={tab()} openTabIds={allLoadedTabs().map((tab) => tab.id)} settings={editorSettings()} searchQuery={search().query} searchReplace={search().replace} searchCaseSensitive={search().caseSensitive} searchRegexp={search().regexp} searchWholeWord={search().wholeWord} searchAction={search().action} searchActionId={search().actionId} searchActionTargetTabId={searchActionTargetTabId()} onSearchActionConsumed={acknowledgeSearchAction} getCachedDocument={documentController.getCachedDocument} goToLine={goToLine()} onFontSizeChange={(fontSize) => updateSettings({ fontSize: clampSetting("fontSize", fontSize, settings().fontSize) })} onDocumentChange={handleDocumentChange} onCursorChange={(tabId, line, column) => { updateTab(tabId, { cursorLine: line, cursorColumn: column }); scheduleCursorPersistence(); }} onRegisterDocument={registerDocument} onUnregisterDocument={unregisterDocument} />
            </div>}</Show>

            <Show when={viewMode() === "diff" && diff()}>{(currentDiff) => <LazyDiffPane contextLines={currentDiff().contextLines} nextContextLines={currentDiff().nextContextLines ?? undefined} loading={diffContextLoading()} onExpandContext={() => void expandDiffContext()} path={currentDiff().path} diff={currentDiff().diff} staged={currentDiff().staged} label={currentDiff().label} backLabel={diffReturnToHistory() ? "Back to history" : undefined} onBack={() => void returnToDiffFile()} />}</Show>
            <Show when={activeTab() && viewMode() === "editor" && isMarkdownPreview()}><LazyMarkdownPreview documentKey={`${activeTab()!.id}:${activeTab()!.contentVersion}`} revision={activeTab()!.revision} length={documentController.getHandle(activeTab()!.id)?.getTextLength() ?? activeTab()!.content.length} readRange={(from, to) => { const tab = activeTab(); return tab ? documentController.getHandle(tab.id)?.getRange(from, to) ?? tab.content.slice(from, to) : ""; }} /></Show>
            <Show when={activeTab()?.language === "Image" && viewMode() === "editor"}><LazyImagePreview path={activeTab()?.path ?? ""} workspace={imageWorkspaceRoot(activeTab()?.path ?? "")} /></Show>
            <Show when={!activeTab() && viewMode() === "editor"}><EmptyEditor onOpenFolder={() => void loadWorkspace()} /></Show>
            <Show when={activeTab()?.language === "Markdown" && viewMode() === "editor"}><button class="markdown-toggle" classList={{ "markdown-toggle-active": isMarkdownPreview() }} disabled={activeTab()?.largeFile} title={activeTab()?.largeFile ? "Markdown preview is disabled in large file mode" : undefined} onClick={() => setMarkdownPreviewEnabled((enabled) => !enabled)} aria-label={isMarkdownPreview() ? "Show Markdown source" : "Show Markdown preview"} aria-pressed={isMarkdownPreview()}><span>{isMarkdownPreview() ? "Source" : "Preview"}</span></button></Show>
            </div>
            <Show when={historyTabOpen()}><div role="tabpanel" id={WORKBENCH_HISTORY_PANEL_ID} aria-labelledby={WORKBENCH_HISTORY_TAB_ID} classList={{ "editor-slot": true, "editor-slot-hidden": viewMode() !== "history" }}><LazyGitPanel historyOnly status={git()} branches={gitBranches()} historyLoading={gitHistoryLoading()} historyIncomplete={gitHistoryIncomplete()} historyHasMore={gitHistoryHasMore()} historyLoadingMore={gitHistoryLoadingOlder()} onLoadMoreHistory={() => void loadOlderGitHistory()} onLoadHistory={() => void loadGitHistory()} onRefreshHistory={() => void refreshGitHistory()} onOpenDiff={(file, staged, untrackedHint) => void openDiff(file, staged, untrackedHint)} onOpenCommitDiff={openCommitDiffFromHistory} onLoadCommitFiles={(commit) => getGitCommitFiles(workspace(), commit.hash)} onAction={(request) => runGitAction(request)} onCreateWorktree={(branchName, path, startPoint) => createGitWorktree(workspace(), branchName, path, startPoint).then((result) => notify(`Created worktree ${result.branch}; opened ${result.path} in a new window.`))} /></div></Show>
          </div>
           <For each={projects().map((project) => project.id)}>{(id) => {
             const project = () => projects().find((item) => item.id === id)!;
             const selected = () => activeProjectId() === id;
             return <Show when={selected() ? terminalInitialized() : project().terminalInitialized}>
               <LazyTerminalPane openRequest={terminalOpenRequests()[id]} workspace={project().workspace} height={settings().terminalHeight} visible={selected() && terminalOpen()} onHide={hideTerminal} onClose={hideTerminal} />
             </Show>;
           }}</For>
        </main>
      </div>

       <footer class="statusbar"><div class="status-left"><span class="status-branch"><Icon name="git" size={12} /> {git().branch ?? "local"}</span><Show when={statusTab()?.dirty}><span class="status-unsaved">Unsaved changes</span></Show><Show when={statusTab()?.orphaned}><span class="status-unsaved">File missing on disk</span></Show></div><div class="status-right"><Show when={statusTab()} fallback={<span>Ready</span>}>{(tab) => <Show when={tab().language === "Image"} fallback={<><span>Ln {tab().cursorLine}, Col {tab().cursorColumn}</span><span>Spaces: {settings().tabSize}</span><span>{tab().encoding}</span><span>{tab().lineEnding.toUpperCase()}</span><span>{tab().language}</span></>}><><span>Image preview</span><span>{tab().name}</span></></Show>}</Show><For each={Object.values(pluginStatusItems())}>{(item) => <span title={item.tooltip}>{item.pluginName}: {item.text}</span>}</For></div></footer>
      <Show when={toast()}><div class="toast" role="status"><Icon name="check" size={14} />{toast()}</div></Show>
      <Show when={commandPaletteOpen()}><LazyCommandPalette commands={commandPaletteItems()} onRun={runPaletteCommand} onClose={() => setCommandPaletteOpen(false)} returnFocus={() => editMenuTrigger} /></Show>
      <Show when={activePluginQuickPick()}>{(request) => (
        <LazyPluginQuickPickDialog
          title={request().title}
          placeholder={request().placeholder}
          items={request().items}
          onSelect={(item) => settlePluginQuickPick(request(), item)}
        />
      )}</Show>
      <Show when={pluginsOpen()}>
        <LazyPluginModal
          plugins={plugins()}
          grants={authorizationStore().grants}
          pendingCleanupIds={pendingCleanupIds()}
          onClose={() => setPluginsOpen(false)}
          onToggle={togglePlugin}
          onInstall={installLocalPlugin}
          onUpdate={updateLocalPlugin}
          onUninstall={(id) => void uninstallLocalPlugin(id)}
          onRetryCleanup={(id) => void retryLocalPluginCleanup(id)}
          onManagePermissions={managePluginPermissions}
        />
      </Show>
      <Show when={authorizationReview()}>{(review) => (
        <LazyPluginAuthorizationDialog
          current={review().current}
          proposed={review().proposed}
          existingGrants={authorizationStore().grants}
          workspaceRoot={review().workspaceRoot}
          onApprove={approvePluginAuthorizationReview}
          onCancel={cancelPluginAuthorizationReview}
        />
      )}</Show>
      <Show when={authorizationManagementOpen()}>
        <LazyPluginAuthorizationManagementDialog
          plugins={plugins()}
          grants={authorizationStore().grants}
          onRevoke={revokePluginPermission}
          onClose={() => { setAuthorizationManagementOpen(false); setPluginsOpen(true); }}
        />
      </Show>
      <Show when={externalConflictController.first()}>{(conflict) => <LazyConflictDialog tab={conflict()} onCompare={() => void compareExternalFile(conflict())} onReload={() => void reloadExternalFile()} onSaveAs={() => void saveExternalFileAs(conflict())} onKeep={() => { externalConflictController.dismiss(conflict().id); notify("Keeping the editor version."); }} />}</Show>
      <Show when={projectCloseId()}><LazyCloseWindowDialog busy={projectCloseBusy()} projectName={baseName(projects().find((project) => project.id === projectCloseId())?.workspace ?? "") || "Files"}
        onSave={() => void closeProjectWithDecision("save")} onDiscard={() => void closeProjectWithDecision("discard")} onCancel={() => setProjectCloseId(undefined)} /></Show>
      <Show when={closePromptOpen()}><LazyCloseWindowDialog busy={closeSaving()} onSave={() => void handleCloseDialogSave()} onDiscard={handleCloseDialogDiscard} onPreserve={handleCloseDialogPreserve} onCancel={handleCloseDialogCancel} /></Show>
      <Show when={confirmationDialog()}>{(dialog) => <LazyConfirmDialog title={dialog().title} message={dialog().message} confirmLabel={dialog().confirmLabel} cancelLabel={dialog().cancelLabel} destructive={dialog().destructive} onConfirm={() => closeConfirmationDialog(true)} onCancel={() => closeConfirmationDialog(false)} />}</Show>
      <Show when={inputDialog()}>{(dialog) => <LazyInputDialog title={dialog().title} label={dialog().label} initialValue={dialog().initialValue} placeholder={dialog().placeholder} submitLabel={dialog().submitLabel} onSubmit={(value) => closeInputDialog(value)} onClose={() => closeInputDialog(null)} />}</Show>
    </div>
  );
}

function EmptyEditor(props: { onOpenFolder: () => void }) {
  const modifier = isMacPlatform() ? "Cmd" : "Ctrl";
  return <div class="empty-editor"><img class="empty-editor-logo" src="/pude-logo.webp" width="156" height="156" alt="pude" /><h1 class="sr-only">pude</h1><p>pure code editor</p><div class="empty-actions"><button class="primary-button" onClick={props.onOpenFolder}><Icon name="folder-open" size={14} /> Open folder</button><span>Open a file with <kbd>{modifier}+O</kbd></span></div><div class="empty-shortcuts"><span><kbd>{modifier}+S</kbd> Save</span><span><kbd>{modifier}+F</kbd> Find</span><span><kbd>{modifier}+Backtick</kbd> Terminal</span></div></div>;
}

const normalizedReadFileResults = new WeakSet<ReadFileResult>();

function makeTab(file: ReadFileResult): EditorTab {
  const normalizedFile = normalizeReadFile(file);
  const content = normalizedFile.content;
  const lineEndings = normalizedFile.lineEndings;
  const encoding = normalizedFile.encoding === "utf-8-bom" ? "UTF-8 BOM" : "UTF-8";
  return { id: createStableTabId(), path: normalizedFile.path, name: baseName(normalizedFile.path), pinned: false, content, savedContent: content, dirty: false, lineEnding: normalizedFile.lineEnding, lineEndings, savedLineEndings: lineEndings, bom: normalizedFile.bom === true, savedBom: normalizedFile.bom === true, encoding, language: fileLanguageForPath(normalizedFile.path).label, cursorLine: 1, cursorColumn: 1, revision: 0, savedRevision: 0, contentVersion: 0, normalizedContentVersion: 0, normalizedSavedRevision: 0, diskModifiedAt: normalizedFile.modifiedAt, diskSize: normalizedFile.size, estimatedBytes: normalizedFile.size, diskFingerprint: normalizedFile.fingerprint, diskIdentity: normalizedFile.identity ?? undefined, largeFile: normalizedFile.size > 5 * 1024 * 1024 };
}

function makeImageTabChanges(size?: number): Omit<EditorTab, "id" | "path" | "name" | "pinned" | "revision" | "savedRevision" | "contentVersion"> {
  return { content: "", savedContent: "", dirty: false, orphaned: false, lineEnding: "lf", lineEndings: "", savedLineEndings: "", bom: false, savedBom: false, encoding: "UTF-8", language: "Image", cursorLine: 1, cursorColumn: 1, diskModifiedAt: undefined, diskSize: size, diskFingerprint: undefined, diskIdentity: undefined, largeFile: false };
}

function makeImageTab(path: string, size?: number): EditorTab {
  return { id: createStableTabId(), path, name: baseName(path), pinned: false, ...makeImageTabChanges(size), revision: 0, savedRevision: 0, contentVersion: 0 };
}

function normalizeReadFile(file: ReadFileResult): ReadFileResult {
  if (normalizedReadFileResults.has(file)) return file;
  const content = normalizeDocumentContent(file.content);
  const lineEndings = normalizeLineEndingMap(content, file.lineEndings, file.lineEnding);
  const normalized = { ...file, content, lineEnding: lineEndingFromMap(lineEndings, file.lineEnding), lineEndings, bom: file.bom === true, fingerprint: file.fingerprint ?? contentFingerprint(content) };
  normalizedReadFileResults.add(normalized);
  return normalized;
}

function createStableTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const loadSessionRestoreDocuments = () => import("./lib/session-restore-documents");
const loadDirectoryRestoreRuntime = () => import("./lib/directory-restore");

function mapRestoreWithConcurrency<T, R>(items: readonly T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  return loadSessionRestoreDocuments().then(({ mapWithConcurrency }) => mapWithConcurrency(items, limit, mapper));
}

async function restoreDirectoryTreeByLevelLazy(options: DirectoryRestoreOptions): Promise<DirectoryRestoreResult> {
  if (!options.isCurrent()) return { tree: options.root, applied: false, interrupted: true };
  const { restoreDirectoryTreeByLevel } = await loadDirectoryRestoreRuntime();
  if (!options.isCurrent()) return { tree: options.root, applied: false, interrupted: true };
  return restoreDirectoryTreeByLevel(options);
}

async function restorePersistedTab(persistedTab: PersistedTab, cursor: CursorPosition | undefined, sessionScope: string, checkpointRecoveries: Readonly<Record<string, RecoverySnapshot>> | undefined, readDocument: (path: string) => Promise<ReadFileResult>, isCurrent: () => boolean): Promise<RestoredTabResult | null> {
  if (!isCurrent()) return null;
  try {
    const { restorePersistedTab: restore } = await loadSessionRestoreDocuments();
    if (!isCurrent()) return null;
    return await restore(persistedTab, cursor, sessionScope, checkpointRecoveries, {
      readDocument,
      normalizeReadFile,
      createImageTab: makeImageTab,
      isCurrent,
    });
  } catch (error) {
    return isCurrent() ? { status: "read-failed", tabId: persistedTab.id, path: persistedTab.path, error } : null;
  }
}

function updateEntry(entry: DirectoryEntry, path: string, update: (entry: DirectoryEntry) => DirectoryEntry): DirectoryEntry {
  if (samePath(entry.path, path)) return update(entry);
  if (!isSameOrDescendantPath(path, entry.path)) return entry;
  if (!entry.children?.length) return entry;
  let changed = false;
  const children = entry.children.map((child) => {
    const next = updateEntry(child, path, update);
    changed ||= next !== child;
    return next;
  });
  return changed ? { ...entry, children } : entry;
}

function markDirectoryStale(entry: DirectoryEntry, targetPath: string): DirectoryEntry {
  if (entry.kind !== "directory" || !isSameOrDescendantPath(targetPath, entry.path)) return entry;
  let changed = false;
  const children = entry.children?.map((child) => {
    const next = markDirectoryStale(child, targetPath);
    changed ||= next !== child;
    return next;
  });
  const shouldMark = samePath(entry.path, targetPath) || entry.expanded !== true;
  if (!shouldMark && !changed) return entry;
  return { ...entry, stale: entry.stale || shouldMark, children: changed ? children : entry.children };
}

function markAllDirectoriesStale(entry: DirectoryEntry): DirectoryEntry {
  if (entry.kind !== "directory") return entry;
  let changed = entry.loaded === true && entry.stale !== true;
  const children = entry.children?.map((child) => {
    const next = markAllDirectoriesStale(child);
    changed ||= next !== child;
    return next;
  });
  if (!changed) return entry;
  return { ...entry, stale: entry.loaded ? true : entry.stale, children: children ?? entry.children };
}

function mergeDirectoryState(previous: DirectoryEntry[] | undefined, next: DirectoryEntry[]) {
  const previousByPath = new Map((previous ?? []).map((entry) => [pathKey(entry.path), entry]));
  return next.map((entry) => {
    const prior = previousByPath.get(pathKey(entry.path));
    if (!prior || prior.kind !== entry.kind || prior.name !== entry.name) return entry;
    if (entry.kind === "directory") return prior;
    return prior.size === entry.size && prior.modifiedAt === entry.modifiedAt ? prior : entry;
  });
}

function baseName(path: string) {
  return wireBasename(path, PATH_OPTIONS);
}

function parentPath(path: string) {
  return wireParentPath(path, PATH_OPTIONS);
}

function joinPath(parent: string, name: string) {
  return joinWirePath(parent, name, PATH_OPTIONS);
}

function normalizePath(path: string) {
  const normalized = PATH_OPTIONS.platform === "windows" ? path.replaceAll("\\", "/") : path;
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

const PATH_OPTIONS = runtimePathOptions();
function pathKey(path: string): string {
  return pathComparisonKey(path, PATH_OPTIONS);
}

function isSameOrDescendantPath(path: string, parent: string): boolean {
  return isDescendantIdentity(path, parent, PATH_OPTIONS);
}

function isGitReferencePath(path: string, repositoryRoot: string): boolean {
  const candidate = pathKey(path);
  const root = pathKey(repositoryRoot);
  const gitRoot = `${root}/.git/`;
  const repositoryRelative = candidate.startsWith(gitRoot) ? candidate.slice(gitRoot.length) : candidate;
  const segments = candidate.split("/");
  const gitDirectoryIndex = segments.findIndex((segment) => segment === ".git" || segment.endsWith(".git"));
  const relative = gitDirectoryIndex >= 0 ? segments.slice(gitDirectoryIndex + 1).join("/") : repositoryRelative;
  return relative === "head"
    || relative === "packed-refs"
    || relative === "config"
    || relative.startsWith("refs/")
    || relative.startsWith("logs/refs/")
    || (gitDirectoryIndex >= 0 && relative.startsWith("worktrees/"))
    || candidate.endsWith("/.git")
    || candidate.endsWith("/head");
}

function sameGitPath(left: string, right: string, repositoryRoot: string): boolean {
  if (samePath(left, right)) return true;
  if (!repositoryRoot) return false;
  return samePath(joinPath(repositoryRoot, left), joinPath(repositoryRoot, right));
}

function isMissingFileError(error: unknown): boolean {
  return isMissingFileReadError(error, PATH_OPTIONS.platform ?? "posix");
}

function findDirectoryEntry(entry: DirectoryEntry, path: string): DirectoryEntry | undefined {
  if (entry.kind === "directory" && samePath(entry.path, path)) return entry;
  for (const child of entry.children ?? []) {
    const found = findDirectoryEntry(child, path);
    if (found) return found;
  }
  return undefined;
}

function renameEntryPaths(entry: DirectoryEntry, from: string, to: string): DirectoryEntry {
  const normalizedEntryPath = pathKey(entry.path);
  const normalizedFrom = pathKey(from);
  if (normalizedEntryPath === normalizedFrom || normalizedEntryPath.startsWith(`${normalizedFrom}/`)) {
    const nextPath = replacePathPrefix(entry.path, from, to);
    return { ...entry, name: normalizedEntryPath === normalizedFrom ? baseName(to) : entry.name, path: nextPath, children: entry.children?.map((child) => renameEntryPaths(child, from, to)) };
  }
  if (!isSameOrDescendantPath(from, entry.path)) return entry;
  if (!entry.children?.length) return entry;
  let changed = false;
  const children = entry.children.map((child) => {
    const next = renameEntryPaths(child, from, to);
    changed ||= next !== child;
    return next;
  });
  return changed ? { ...entry, children } : entry;
}

function replacePathPrefix(path: string, from: string, to: string): string {
  const normalizedPath = normalizePath(path);
  const normalizedFrom = normalizePath(from);
  const suffix = normalizedPath.slice(normalizedFrom.length).replace(/^\/+/, "");
  if (!suffix) return to;
  return joinPath(to, suffix);
}

function isSafeEntryName(name: string) {
  return Boolean(name) && name !== "." && name !== ".." && !name.includes("\0")
    && !(PATH_OPTIONS.platform === "windows" ? /[\\/]/ : /\//).test(name);
}

function detectWindowPlatform(): "mac" | "windows" | "linux" {
  if (typeof navigator === "undefined") return "windows";
  const platform = navigator.platform || navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(platform)) return "mac";
  if (/Win/.test(platform)) return "windows";
  return "linux";
}

function isMacPlatform() {
  return windowPlatform === "mac";
}

function makeRecentProjectsRoot(paths: string[]): DirectoryEntry {
  return {
    name: "recent project",
    path: "pude://recent-projects",
    kind: "directory",
    expanded: true,
    loaded: true,
    children: paths.map((path) => ({ name: baseName(path), path, kind: "directory", loaded: false, expanded: false, recentProject: true })),
  };
}

function loadPlugins(): InstalledPlugin[] {
  try {
    const raw = JSON.parse(readStorage(PLUGINS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .map(parsePersistedPlugin)
      .filter((plugin): plugin is InstalledPlugin => Boolean(plugin))
      .filter((plugin, index, items) => items.findIndex((item) => item.id === plugin.id) === index);
  } catch {
    return [];
  }
}

function parsePersistedPlugin(value: unknown): InstalledPlugin | null {
  return parseInstalledPlugin(value);
}

function loadRecentProjects() {
  try {
    const stored = JSON.parse(readStorage("pude-recent-projects-v1") ?? "[]");
    if (!Array.isArray(stored)) return [] as string[];
    return stored.filter((path): path is string => typeof path === "string" && path.length > 0 && path !== "pude-demo").slice(0, 8);
  } catch {
    return [] as string[];
  }
}

function loadSettings(): AppSettings {
  try {
    const stored = JSON.parse(readStorage("pude-settings-v1") ?? "null");
    return validateSettings(stored, defaultSettings);
  } catch {
    return { ...defaultSettings };
  }
}

async function resolveSessionScope(): Promise<string> {
  if (isTauri) return (await getWindowApi()).getCurrentWindow().label;
  if (typeof window === "undefined") return "default";
  if (!window.name) window.name = `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return window.name;
}

function samePath(left: string, right: string): boolean {
  return samePathIdentity(left, right, PATH_OPTIONS);
}

function gitSnapshotKey(status: Pick<GitStatusResult, "repositoryRoot" | "repositoryState" | "branch" | "headOid">): string {
  return `${status.repositoryRoot}:${status.repositoryState ?? "unknown"}:${status.branch ?? ""}:${status.headOid ?? ""}`;
}

function buildTextDiff(before: string, after: string): string {
  const beforeLines = normalizeDocumentContent(before).split("\n");
  const afterLines = normalizeDocumentContent(after).split("\n");
  const rows = [
    "--- editor",
    "+++ disk",
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ];
  return rows.join("\n");
}
