export type EntryKind = "file" | "directory" | "symlink";

export type DirectoryEntry = {
  name: string;
  path: string;
  kind: EntryKind;
  size?: number;
  modifiedAt?: number;
  children?: DirectoryEntry[];
  loaded?: boolean;
  expanded?: boolean;
  stale?: boolean;
  recentProject?: boolean;
  partialError?: DirectoryPartialError;
  incomplete?: boolean;
  listingStopReason?: "entryLimit" | "byteLimit" | "cancelled" | null;
};

export type LineEnding = "lf" | "crlf";

/**
 * A compact per-line-ending map. Each character describes the separator after
 * the corresponding normalized LF line: `l` is LF and `c` is CRLF.
 */
export type LineEndingMap = string;

export type FileEncoding = "utf-8" | "utf-8-bom";
export type EditorEncoding = "UTF-8" | "UTF-8 BOM";

export type EditorSelectionFallback = {
  revision: number;
  contentVersion: number;
  selection: {
    main: number;
    ranges: Array<{ anchor: number; head: number }>;
  };
};

export type ReadFileResult = {
  path: string;
  content: string;
  encoding: FileEncoding;
  lineEnding: LineEnding;
  lineEndings: LineEndingMap;
  bom: boolean;
  modifiedAt: number;
  size: number;
  fingerprint: string;
  identity: string | null;
};

export type EditorTab = {
  id: string;
  path: string;
  name: string;
  pinned?: boolean;
  content: string;
  savedContent: string;
  dirty: boolean;
  orphaned?: boolean;
  lineEnding: LineEnding;
  lineEndings?: LineEndingMap;
  savedLineEndings?: LineEndingMap;
  bom?: boolean;
  savedBom?: boolean;
  encoding: EditorEncoding;
  language: string;
  cursorLine: number;
  cursorColumn: number;
  revision: number;
  savedRevision: number;
  contentVersion: number;
  normalizedContentVersion?: number;
  normalizedSavedRevision?: number;
  /** Bounded in-memory fallback used only after a clean editor cache is evicted. */
  selectionFallback?: EditorSelectionFallback;
  diskModifiedAt?: number;
  diskSize?: number;
  diskFingerprint?: string;
  diskIdentity?: string;
  largeFile?: boolean;
  estimatedBytes?: number;
};

export type GitFileStatus = {
  path: string;
  indexStatus: string | null;
  worktreeStatus: string | null;
  originalPath?: string;
  conflict?: boolean;
};

export type GitCommitFile = {
  path: string;
  status: string;
  originalPath?: string;
};

export type GitCommit = {
  hash: string;
  parents?: string[];
  shortHash: string;
  author: string;
  date: string;
  authoredAt?: string;
  subject: string;
  body?: string;
  refs: string[];
  files: GitCommitFile[];
};

export type GitHistoryPage = {
  commits: GitCommit[];
  hasMore: boolean;
  cursor: string | null;
  complete: boolean;
  unresolvedRefs: string[];
  incompleteReason: string | null;
};

export type GitStatusResult = {
  repositoryRoot: string;
  branch: string | null;
  repositoryState?: "normal" | "detached" | "unborn" | "unknown";
  headOid?: string | null;
  files: GitFileStatus[];
  commits: GitCommit[];
  error?: string | null;
  statusRevision?: number;
  branchesRevision?: number;
  historyRevision?: number;
};

export type GitBranch = {
  name: string;
  current: boolean;
};

export type GitAction =
  | "add"
  | "stage-file"
  | "unstage-file"
  | "unstage-all"
  | "discard-file"
  | "discard-untracked-file"
  | "commit"
  | "commit-all"
  | "push"
  | "pull"
  | "stash"
  | "stash-pop"
  | "switch"
  | "create-branch"
  | "delete-branch";

export type GitActionRequest = {
  action: GitAction;
  value?: string;
  originalPath?: string;
  message?: string;
  startPoint?: string;
};

export type GitOperationResult = {
  output: string;
};

export type GitWorktreeResult = {
  branch: string;
  path: string;
};

/** Structured errors returned by native Git commands through Tauri. */
export type GitErrorKind =
  | "unavailable"
  | "notRepository"
  | "failed"
  | "timedOut"
  | "cancelled"
  | "outputLimit"
  | "io"
  | "internal"
  | "cleanupFailed"
  | "capacity";

export type GitErrorInfo = {
  kind: GitErrorKind;
  message: string;
  exitCode: number | null;
  stream: string | null;
  limit: number | null;
};

export type DiffResult = {
  path: string;
  diff: string;
  staged: boolean;
  label?: string;
  contextLines?: number;
  nextContextLines?: number | null;
  outputBytes?: number;
  truncated?: boolean;
  commit?: string;
  untrackedHint?: boolean;
};

export type SaveFileResult = {
  modifiedAt: number;
  size: number;
  fingerprint: string;
  identity: string | null;
};

export type PluginPermission =
  | "editor.read"
  | "editor.write"
  | "workspace.read"
  | "workspace.write"
  | "commands.register"
  | "ui.notification"
  | "ui.statusBar"
  | "ui.quickPick"
  | "git.read"
  | "terminal.write"
  | "network"
  | "process.spawn:lsp";

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  apiVersion: "1" | "2";
  entry: string;
  permissions: PluginPermission[];
  activationEvents: string[];
  contributes?: {
    commands?: PluginCommandContribution[];
  };
  networkDomains?: string[];
  lspServers?: PluginLspServer[];
};

export type PluginCommandContribution = {
  command: string;
  title: string;
};

export type PluginLspServer = {
  serverId: string;
  language: string;
  executable: string;
  args: string[];
};

export type InstalledPlugin = PluginManifest & {
  enabled: boolean;
  status: "inactive" | "active" | "failed";
  source: "local";
  rootPath?: string;
};

export type AppSettings = {
  theme: "dark" | "light";
  fontSize: number;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: boolean;
  sidebarWidth: number;
  terminalHeight: number;
  hideDotFiles: boolean;
  checkForUpdates: boolean;
  watcherExcludes: string[];
};

export type FileChangeKind = "create" | "remove" | "rename" | "modify" | "rescan";

/** Serialized watch root/source kinds returned by the native watcher. */
export type FileChangeSource = "workspace" | "worktree" | "gitDir" | "commonDir" | "external" | "unknown";

export type GitDirtyScope = "worktree" | "index" | "head" | "refs" | "unknown";

export type WatchRootKind = "workspace" | "worktree" | "gitDir" | "commonDir" | "external";

export type WatchRoot = {
  path: string;
  kind: WatchRootKind;
};

export type FileChange = {
  kind: FileChangeKind;
  path: string;
  oldPath?: string;
  isDirectory?: boolean;
  source?: FileChangeSource;
  gitScopes?: GitDirtyScope[];
};

export type FileChangedEvent = {
  sessionId?: string;
  sequence?: number;
  revision?: number;
  paths: string[];
  changes?: FileChange[];
  needsRescan?: boolean;
  error?: string | null;
  source?: FileChangeSource;
  watchRoots?: WatchRoot[];
  gitDir?: string | null;
  commonDir?: string | null;
};

export type DirectoryListResult = {
  entries: DirectoryEntry[];
  partialError?: DirectoryPartialError | null;
  incomplete?: boolean;
  stopReason?: "entryLimit" | "byteLimit" | "cancelled" | null;
  maxEntries?: number;
  scannedEntries?: number;
  entriesBytes?: number;
};

export type DirectoryPartialError = {
  kind: "entry" | "metadata" | "unsupported_path";
  message: string;
  count?: number;
};
