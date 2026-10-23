import { Channel, invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { contentFingerprint } from "./fingerprint";
import { lineEndingMapForContent, normalizeLineEndingMap, serializeDocumentBytes } from "./file-metadata";
// The browser-demo dataset is only used when !isTauri; loading it
// through a dynamic import keeps it (and its file contents) out of the
// desktop entry chunk.
type DemoModules = typeof import("./demo");
let demoModulesPromise: Promise<DemoModules> | undefined;
const getDemoModules = () => (demoModulesPromise ??= import("./demo"));
import type {
  DirectoryEntry,
  DirectoryListResult,
  DiffResult,
  FileChangedEvent,
  GitActionRequest,
  GitBranch,
  GitCommitFile,
  GitHistoryPage,
  GitOperationResult,
  GitStash,
  GitStashFile,
  GitStatusResult,
  GitWorktreeResult,
  InstalledPlugin,
  PluginManifest,
  LineEnding,
  LineEndingMap,
  ReadFileResult,
  SaveFileResult,
} from "../types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
type WorkspaceImageResult = { mimeType: string; dataBase64: string };
export type SaveAsDestinationState = { exists: boolean; token: string };
type PluginRuntime = typeof import("./plugin-runtime");
let pluginRuntimePromise: Promise<PluginRuntime> | undefined;
const getPluginRuntime = () => (pluginRuntimePromise ??= import("./plugin-runtime"));
type PluginRecoveryRuntime = typeof import("./plugin-recovery-runtime");
let pluginRecoveryRuntimePromise: Promise<PluginRecoveryRuntime> | undefined;
const getPluginRecoveryRuntime = () => (pluginRecoveryRuntimePromise ??= import("./plugin-recovery-runtime"));

export async function getStartupFolder(): Promise<string | null> {
  return isTauri ? invoke<string | null>("startup_folder") : null;
}
const browserBranches: GitBranch[] = [
  { name: "main", current: true },
  { name: "feature/editor-tabs", current: false },
];

function browserFile(path: string): Promise<ReadFileResult | null> {
  return getDemoModules().then(({ demoFiles }) => {
    const file = demoFiles[path];
    return file ? { ...file, content: file.content } : null;
  });
}

export async function openFolder(): Promise<string | null> {
  if (isTauri) return invoke<string | null>("open_folder_dialog");
  return (await getDemoModules()).demoWorkspace;
}

export async function openFileDialog(): Promise<string | null> {
  if (isTauri) return invoke<string | null>("open_file_dialog");
  return "pude-demo/src/editor.ts";
}

export type WorkspaceFileInfo = {
  path: string;
  name: string;
  /** Existing folders in file order. */
  folders: string[];
  /** Folders listed in the file that no longer exist. */
  missing: string[];
};

export async function openWorkspaceFileDialog(): Promise<string | null> {
  return isTauri ? invoke<string | null>("open_workspace_file_dialog") : null;
}

export async function saveWorkspaceFileDialog(defaultName: string): Promise<string | null> {
  return isTauri ? invoke<string | null>("save_workspace_file_dialog", { defaultName }) : null;
}

export async function readWorkspaceFile(path: string): Promise<WorkspaceFileInfo> {
  if (!isTauri) throw new Error("Workspace files are available in the desktop build.");
  return invoke<WorkspaceFileInfo>("read_workspace_file", { path });
}

export async function writeWorkspaceFile(path: string, folders: string[]): Promise<void> {
  if (!isTauri) throw new Error("Workspace files are available in the desktop build.");
  await invoke("write_workspace_file", { path, folders });
}

/** Recent folders and workspaces for the Dock menu (macOS) and Jump List (Windows). */
export type LauncherMenuLabels = { newWindow: string; newWindowDescription: string; recentFolders: string; recentWorkspaces: string };

export async function setRecentItems(folders: string[], workspaces: string[], labels: LauncherMenuLabels): Promise<void> {
  if (isTauri) await invoke("set_recent_items", { folders, workspaces, labels });
}

export async function saveFileDialog(defaultName: string): Promise<string | null> {
  if (isTauri) return invoke<string | null>("save_file_dialog", { defaultName });
  return null;
}

export async function listDirectory(path: string, requestId?: string): Promise<DirectoryListResult> {
  if (isTauri) return invoke<DirectoryListResult>("list_directory", { path, requestId });
  const { demoTree, demoWorkspace } = await getDemoModules();
  if (path === demoWorkspace) return { entries: demoTree.children ?? [] };
  const node = findDemoEntry(demoTree, path);
  return { entries: node?.children ?? [] };
}

export async function cancelDirectoryListing(requestId: string): Promise<boolean> {
  return isTauri ? invoke<boolean>("cancel_directory_listing", { requestId }) : false;
}

export async function readFile(path: string): Promise<ReadFileResult> {
  if (isTauri) return invoke<ReadFileResult>("read_file", { path });
  const file = await browserFile(path);
  if (!file) throw new Error("This file cannot be displayed as text.");
  return { ...file, fingerprint: file.fingerprint ?? contentFingerprint(file.content) };
}

export async function readWorkspaceImage(path: string, workspace: string): Promise<ArrayBuffer> {
  if (isTauri) {
    // The native side returns raw bytes (tauri::ipc::Response), which Tauri v2
    // delivers to the frontend as an ArrayBuffer. No base64 round-trip.
    return invoke<ArrayBuffer>("read_workspace_image", { path, workspace });
  }

  const { demoWorkspace } = await getDemoModules();
  const demoImagePath = `${demoWorkspace}/assets/pude-logo.webp`;
  if (workspace !== demoWorkspace || path !== demoImagePath) throw new Error("This image is not available in the web demo.");
  const response = await fetch("/pude-logo.webp");
  if (!response.ok) throw new Error("Unable to load the demo image.");
  const image = await response.blob();
  if (image.size > 8 * 1024 * 1024 || image.type.toLowerCase() !== "image/webp") throw new Error("The demo image is not a supported WebP file.");
  return image.arrayBuffer();
}

export type StatFileEntry = {
  path: string;
  exists: boolean;
  modifiedAt: number | null;
  size: number | null;
  identity: string | null;
};

// Batch metadata probe: lets the frontend detect touched files with a
// single IPC round-trip instead of reading every open file back in full.
export async function statFiles(paths: string[]): Promise<StatFileEntry[]> {
  if (isTauri) {
    const result = await invoke<{ entries: StatFileEntry[] }>("stat_files", { request: { paths } });
    return result.entries;
  }
  const { demoFiles } = await getDemoModules();
  return paths.map((path) => {
    const file = demoFiles[path];
    return {
      path,
      exists: Boolean(file),
      modifiedAt: file ? file.modifiedAt : null,
      size: file ? file.size : null,
      identity: file ? (file.identity ?? `demo:${path}`) : null,
    };
  });
}

export async function saveFile(path: string, content: string, lineEnding: LineEnding, lineEndings?: LineEndingMap, bom = false, expectedModifiedAt?: number, expectedSize?: number, expectedFingerprint?: string): Promise<SaveFileResult> {
  if (isTauri) {
    return invoke<SaveFileResult>("save_file", { path, content, lineEnding, lineEndings, bom, expectedModifiedAt, expectedSize, expectedFingerprint });
  }
  const { demoFiles, demoTree } = await getDemoModules();
  const existing = demoFiles[path];
  if (existing) {
    if (expectedModifiedAt !== undefined && existing.modifiedAt !== expectedModifiedAt) throw new Error("The file changed on disk while it was being saved.");
    if (expectedSize !== undefined && existing.size !== expectedSize) throw new Error("The file size changed on disk while it was being saved.");
    const existingFingerprint = existing.fingerprint ?? contentFingerprint(existing.content);
    if (expectedFingerprint !== undefined && existingFingerprint !== expectedFingerprint) throw new Error("The file contents changed on disk while it was being saved.");
    existing.content = content;
    existing.lineEnding = lineEnding;
    existing.lineEndings = normalizeLineEndingMap(content, lineEndings ?? existing.lineEndings ?? lineEndingMapForContent(content, lineEnding), lineEnding);
    existing.bom = bom;
    existing.encoding = bom ? "utf-8-bom" : "utf-8";
    existing.size = serializeDocumentBytes(content, existing.lineEndings, bom).byteLength;
    existing.modifiedAt = Date.now();
    const entry = findDemoEntry(demoTree, path);
    if (entry) {
      entry.size = existing.size;
      entry.modifiedAt = existing.modifiedAt;
    }
    existing.fingerprint = contentFingerprint(content);
    return { modifiedAt: existing.modifiedAt, size: existing.size, fingerprint: existing.fingerprint, identity: existing.identity };
  }
  throw new Error("The file no longer exists.");
}

export async function inspectSaveAsDestination(path: string): Promise<SaveAsDestinationState> {
  if (isTauri) return invoke<SaveAsDestinationState>("inspect_save_as_destination", { path });
  const { demoFiles } = await getDemoModules();
  const existing = demoFiles[path];
  return {
    exists: Boolean(existing),
    token: JSON.stringify(existing
      ? { path, modifiedAt: existing.modifiedAt, size: existing.size, fingerprint: existing.fingerprint ?? contentFingerprint(existing.content) }
      : { path, absent: true }),
  };
}

export async function saveFileAs(path: string, content: string, lineEnding: LineEnding, lineEndings: LineEndingMap | undefined, bom: boolean, destinationState: string): Promise<SaveFileResult> {
  if (isTauri) return invoke<SaveFileResult>("save_file_as", { path, content, lineEnding, lineEndings, bom, destinationState });
  const observed = await inspectSaveAsDestination(path);
  if (observed.token !== destinationState) throw new Error("The destination changed while Save As was open. Review it again before replacing it.");
  const { demoFiles } = await getDemoModules();
  const existing = demoFiles[path];
  if (existing) return saveFile(path, content, lineEnding, lineEndings, bom);
  throw new Error("Save As is available in the desktop build.");
}

export async function pathExists(path: string): Promise<boolean> {
  if (isTauri) return invoke<boolean>("path_exists", { path });
  const { demoTree } = await getDemoModules();
  return Boolean(findDemoEntry(demoTree, path));
}

export async function createFile(path: string): Promise<void> {
  if (isTauri) {
    await invoke("create_file", { path });
    return;
  }
  const { demoFiles, demoTree, demoWorkspace } = await getDemoModules();
  if (findDemoEntry(demoTree, path)) throw new Error("Unable to create file. The item already exists.");
  const parent = findDemoEntry(demoTree, parentDemoPath(demoWorkspace, path));
  if (!parent || parent.kind !== "directory") throw new Error("Unable to create file. The parent folder no longer exists.");
  const name = demoBaseName(path);
  const file: ReadFileResult = { path, content: "", encoding: "utf-8", lineEnding: "lf", lineEndings: "", bom: false, modifiedAt: Date.now(), size: 0, fingerprint: contentFingerprint(""), identity: `demo:${path}` };
  demoFiles[path] = file;
  parent.children = [...(parent.children ?? []), { name, path, kind: "file", size: 0 }];
}

export async function createDirectory(path: string): Promise<void> {
  if (isTauri) {
    await invoke("create_directory", { path });
    return;
  }
  const { demoTree, demoWorkspace } = await getDemoModules();
  if (findDemoEntry(demoTree, path)) throw new Error("Unable to create folder. The item already exists.");
  const parent = findDemoEntry(demoTree, parentDemoPath(demoWorkspace, path));
  if (!parent || parent.kind !== "directory") throw new Error("Unable to create folder. The parent folder no longer exists.");
  parent.children = [...(parent.children ?? []), { name: demoBaseName(path), path, kind: "directory", expanded: false, loaded: true, children: [] }];
}

export async function renamePath(from: string, to: string): Promise<void> {
  if (isTauri) {
    await invoke("rename_path", { from, to });
    return;
  }
  await renameDemoPath(await getDemoModules(), from, to);
}

export async function deletePath(path: string): Promise<void> {
  if (isTauri) {
    await invoke("delete_path", { path });
    return;
  }
  const { demoFiles, demoTree } = await getDemoModules();
  const parent = findDemoParent(demoTree, path);
  if (!parent?.children) throw new Error("Unable to delete item. The item no longer exists.");
  const index = parent.children.findIndex((entry) => entry.path === path);
  if (index < 0) throw new Error("Unable to delete item. The item no longer exists.");
  parent.children.splice(index, 1);
  for (const filePath of Object.keys(demoFiles)) {
    if (filePath === path || filePath.startsWith(`${path}/`)) delete demoFiles[filePath];
  }
}

export async function getGitIgnoredPaths(workspace: string, paths: string[]): Promise<string[]> {
  return isTauri ? invoke<string[]>("get_git_ignored_paths", { workspace, paths }) : [];
}

export async function getGitStatus(workspace: string): Promise<GitStatusResult> {
  if (isTauri) return invoke<GitStatusResult>("git_status", { workspace });
  const { demoGit } = await getDemoModules();
  return {
    ...demoGit,
    files: demoGit.files.map((file) => ({ ...file })),
    commits: demoGit.commits.map((commit) => ({ ...commit, refs: [...commit.refs], files: commit.files.map((file) => ({ ...file })) })),
  };
}

export async function getGitBranches(workspace: string): Promise<GitBranch[]> {
  if (isTauri) return invoke<GitBranch[]>("git_branches", { workspace });
  return browserBranches.map((branch) => ({ ...branch }));
}

export async function getGitCommits(workspace: string, cursor: string | null = null, pageSize = 60): Promise<GitHistoryPage> {
  if (isTauri) return invoke<GitHistoryPage>("git_commits", { workspace, cursor, pageSize });
  const { demoGit } = await getDemoModules();
  const offset = cursor?.startsWith("demo:") ? Number(cursor.slice(5)) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Git history cursor is invalid.");
  const commits = demoGit.commits.slice(offset, offset + pageSize).map((commit) => ({ ...commit, refs: [...commit.refs], files: commit.files.map((file) => ({ ...file })) }));
  const hasMore = offset + pageSize < demoGit.commits.length;
  return { commits, hasMore, cursor: hasMore ? `demo:${offset + pageSize}` : null, complete: true, unresolvedRefs: [], incompleteReason: null };
}

export async function performGitAction(workspace: string, request: GitActionRequest): Promise<GitOperationResult> {
  if (isTauri) {
    return invoke<GitOperationResult>("git_operation", {
      workspace,
      action: request.action,
      value: request.value ?? null,
      originalPath: request.originalPath ?? null,
      message: request.message ?? null,
      startPoint: request.startPoint ?? null,
    });
  }

  const { demoGit } = await getDemoModules();
  const stageFile = (path: string) => {
    const file = demoGit.files.find((entry) => entry.path === path);
    if (!file) throw new Error(`File not found: ${path}`);
    file.indexStatus = file.indexStatus ?? (file.worktreeStatus === "?" ? "A" : file.worktreeStatus ?? "M");
    file.worktreeStatus = null;
  };
  const unstageFile = (path: string) => {
    const file = demoGit.files.find((entry) => entry.path === path);
    if (!file || !file.indexStatus) throw new Error(`Staged file not found: ${path}`);
    file.worktreeStatus = file.worktreeStatus ?? (file.indexStatus === "A" ? "?" : file.indexStatus);
    file.indexStatus = null;
  };
  if (request.action === "add" || request.action === "commit-all") {
    for (const file of demoGit.files) stageFile(file.path);
  }
  if (request.action === "stage-file" && request.value) stageFile(request.value);
  if (request.action === "unstage-file" && request.value) unstageFile(request.value);
  if (request.action === "unstage-all") {
    for (const file of [...demoGit.files]) if (file.indexStatus) unstageFile(file.path);
  }
  if (request.action === "discard-file" && request.value) {
    const file = demoGit.files.find((entry) => entry.path === request.value);
    if (!file) throw new Error(`File not found: ${request.value}`);
    if (file.indexStatus) file.worktreeStatus = null;
    else demoGit.files = demoGit.files.filter((entry) => entry !== file);
  }
  if (request.action === "discard-untracked-file" && request.value) {
    demoGit.files = demoGit.files.filter((entry) => entry.path !== request.value);
  }
  if (request.action === "commit" || request.action === "commit-all") {
    const message = request.message?.trim();
    if (!message) throw new Error("Commit message cannot be empty.");
    const staged = demoGit.files.filter((file) => file.indexStatus);
    if (!staged.length) throw new Error("There are no staged changes to commit.");
    const hash = (demoGit.commits.length + 1).toString(16).padStart(40, "0");
    const previous = demoGit.commits[0];
    if (previous) previous.refs = previous.refs.filter((ref) => !ref.startsWith("HEAD ->"));
    demoGit.commits.unshift({ hash, shortHash: hash.slice(0, 7), parents: previous ? [previous.hash] : [], author: "pude", date: new Date().toISOString().slice(0, 10), subject: message.split("\n")[0], body: message.includes("\n") ? message.slice(message.indexOf("\n") + 1).trim() : undefined, refs: [`HEAD -> ${demoGit.branch}`], files: staged.map((file) => ({ path: file.path, status: file.indexStatus ?? "M" })) });
    demoGit.files = demoGit.files.filter((file) => !file.indexStatus || file.worktreeStatus).map((file) => file.indexStatus ? { ...file, indexStatus: null } : file);
    demoGit.headOid = hash;
  }
  if (request.action === "switch" && request.value) {
    if (!browserBranches.some((branch) => branch.name === request.value)) throw new Error(`Branch not found: ${request.value}`);
    browserBranches.forEach((branch) => { branch.current = branch.name === request.value; });
    demoGit.branch = request.value;
  }
  if (request.action === "create-branch" && request.value) {
    if (browserBranches.some((branch) => branch.name === request.value)) throw new Error(`Branch already exists: ${request.value}`);
    browserBranches.forEach((branch) => { branch.current = false; });
    browserBranches.push({ name: request.value, current: true });
    demoGit.branch = request.value;
  }
  if (request.action === "delete-branch" && request.value) {
    if (request.value === demoGit.branch) throw new Error("Cannot delete the current branch.");
    const index = browserBranches.findIndex((branch) => branch.name === request.value);
    if (index < 0) throw new Error(`Branch not found: ${request.value}`);
    browserBranches.splice(index, 1);
  }
  return { output: `${request.action} completed in browser preview.` };
}

export async function createGitWorktree(workspace: string, branchName: string, path: string, startPoint?: string): Promise<GitWorktreeResult> {
  if (!isTauri) throw new Error("Creating a Git worktree is available in the desktop build.");
  return invoke<GitWorktreeResult>("create_git_worktree", {
    workspace,
    branchName,
    path,
    startPoint: startPoint ?? null,
  });
}

export async function openNewWindow(workspace?: string): Promise<void> {
  if (isTauri) {
    await invoke("open_new_window", { workspace: workspace ?? null });
    return;
  }
  window.open(window.location.href, "_blank", "noopener,noreferrer");
}

// `untrackedHint` lets the Rust side skip a `git status` pass —
// Some(true) treats the path as untracked, Some(false) as tracked. Omitting it
// preserves the previous behavior.
export async function getGitDiff(workspace: string, path: string, staged = false, untrackedHint?: boolean, contextLines = 3): Promise<DiffResult> {
  if (isTauri) return invoke<DiffResult>("git_diff", { workspace, path, staged, untrackedHint: untrackedHint ?? null, contextLines });
  const { demoDiff } = await getDemoModules();
  return { path, diff: demoDiff(path), staged, contextLines, nextContextLines: contextLines < 100 ? Math.min(100, contextLines * 3) : null };
}

export async function getGitCommitDiff(workspace: string, commit: string, path: string, contextLines = 3): Promise<DiffResult> {
  if (isTauri) return invoke<DiffResult>("git_commit_diff", { workspace, commit, path, contextLines });
  const { demoCommitDiff } = await getDemoModules();
  return { path, diff: demoCommitDiff(path), staged: false, label: `COMMIT ${commit.slice(0, 8)}`, contextLines, nextContextLines: contextLines < 100 ? Math.min(100, contextLines * 3) : null };
}

export async function getGitCommitFiles(workspace: string, commit: string): Promise<GitCommitFile[]> {
  if (isTauri) return invoke<GitCommitFile[]>("git_commit_files", { workspace, commit });
  const { demoGit } = await getDemoModules();
  return demoGit.commits.find((item) => item.hash === commit)?.files.map((file) => ({ ...file })) ?? [];
}

export async function getGitStashes(workspace: string): Promise<GitStash[]> {
  return isTauri ? invoke<GitStash[]>("git_stashes", { workspace }) : [];
}

export async function getGitStashFiles(workspace: string, stash: string): Promise<GitStashFile[]> {
  return isTauri ? invoke<GitStashFile[]>("git_stash_files", { workspace, stash }) : [];
}

export async function getGitStashDiff(workspace: string, stash: string, path: string, untracked: boolean, contextLines = 3): Promise<DiffResult> {
  if (!isTauri) throw new Error("Stash diffs are available in the desktop build.");
  return invoke<DiffResult>("git_stash_diff", { workspace, stash, path, untracked, contextLines });
}

/**
 * `filesystem-changed` is delivered over a per-session
 * `tauri::ipc::Channel` created here and passed to `watch_workspace`, instead
 * of a window-broadcast event. The channel is bound to the watcher session at
 * start; every restart goes through this function again and therefore gets a
 * fresh channel, preserving the sessionId semantics SB-04 relies on.
 */
export async function startWatcher(workspace: string, extraPaths: string[] = [], excludes: string[] = [], openFiles: string[] = [], onEvent: (event: FileChangedEvent) => void = () => undefined): Promise<string | undefined> {
  if (!isTauri) return undefined;
  const channel = new Channel<FileChangedEvent>();
  channel.onmessage = onEvent;
  return invoke<string>("watch_workspace", { workspace, extraPaths, excludes, openFiles, events: channel });
}

export async function cancelWorkspaceOperations(workspace: string): Promise<void> {
  if (isTauri) await invoke("cancel_workspace", { workspace });
}

export async function stopWatcher(sessionId?: string): Promise<void> {
  if (!isTauri) return;
  await invoke("stop_watcher", sessionId ? { sessionId } : {});
}

/**
 * `terminal-output` is delivered over a per-session channel owned
 * by the terminal session, so only this WebView receives its stream.
 */
export async function startTerminal(workspace: string, rows: number, cols: number, onOutput: (payload: TerminalOutputPayload) => void, workingDirectory?: string): Promise<string> {
  if (isTauri) {
    const channel = new Channel<TerminalOutputPayload>();
    channel.onmessage = onOutput;
    return invoke<string>("terminal_start", { workspace, workingDirectory, rows, cols, events: channel });
  }
  return "browser-terminal";
}

export async function writeTerminal(sessionId: string, data: string, binary = false): Promise<void> {
  if (isTauri) {
    await invoke("terminal_write", { sessionId, data, binary });
  }
}

export async function killTerminal(sessionId: string): Promise<void> {
  if (isTauri) await invoke("terminal_kill", { sessionId });
}

export async function resizeTerminal(sessionId: string, rows: number, cols: number): Promise<void> {
  if (isTauri) await invoke("terminal_resize", { sessionId, rows, cols });
}

export type PluginInstallPlan = {
  transactionId: string;
  manifest: PluginManifest;
  installedManifest: PluginManifest | null;
};

export type PluginInstallResult = {
  plugin: InstalledPlugin;
  cleanupPending: boolean;
};

export async function inspectPluginInstall(): Promise<PluginInstallPlan | null> {
  if (!isTauri) return null;
  return (await getPluginRuntime()).inspectPluginInstall();
}

export async function commitPluginInstall(transactionId: string): Promise<PluginInstallResult> {
  if (!isTauri) throw new Error("Local plugin installation is available in the desktop build.");
  return (await getPluginRuntime()).commitPluginInstall(transactionId);
}

export async function cancelPluginInstall(transactionId: string): Promise<void> {
  if (!isTauri) return;
  await (await getPluginRuntime()).cancelPluginInstall(transactionId);
}

export async function uninstallPlugin(id: string): Promise<{ removed: boolean; cleanupPending: boolean }> {
  if (!isTauri) throw new Error("Local plugin removal is available in the desktop build.");
  return (await getPluginRuntime()).uninstallPlugin(id);
}

export async function rollbackPluginUpdate(id: string): Promise<InstalledPlugin> {
  if (!isTauri) throw new Error("Local plugin rollback is available in the desktop build.");
  return (await getPluginRuntime()).rollbackPluginUpdate(id);
}

export async function retryPluginCleanup(id: string): Promise<boolean> {
  if (!isTauri) throw new Error("Local plugin cleanup is available in the desktop build.");
  return (await getPluginRuntime()).retryPluginCleanup(id);
}

export type PluginStartupRecoveryResult = {
  plugins: InstalledPlugin[];
  pendingCleanupIds: string[];
};

export async function recoverPluginUpdates(ids: string[]): Promise<PluginStartupRecoveryResult> {
  if (!isTauri) throw new Error("Plugin recovery is available in the desktop build.");
  return (await getPluginRecoveryRuntime()).recoverPluginUpdates(ids);
}

export async function readPluginEntry(rootPath: string, entry: string): Promise<string> {
  if (!isTauri) throw new Error("Local plugin entry files are available in the desktop build.");
  return (await getPluginRuntime()).readPluginEntry(rootPath, entry);
}

export type PluginWorkspaceEntry = {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
  size?: number;
  modifiedAt?: number;
};

export type PluginWorkspaceListResult = {
  entries: PluginWorkspaceEntry[];
};

export type PluginWorkspaceWriteResult = {
  created: boolean;
  modifiedAt: number;
  size: number;
  fingerprint: string;
};

export type PluginNetworkResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export async function canonicalizeWorkspaceRoot(workspace: string): Promise<string> {
  if (!isTauri) return workspace;
  return (await getPluginRuntime()).canonicalizeWorkspaceRoot(workspace);
}

export async function pluginWorkspaceList(workspace: string, path = "."): Promise<PluginWorkspaceListResult> {
  if (!isTauri) throw new Error("Plugin workspace access is available in the desktop build.");
  return (await getPluginRuntime()).pluginWorkspaceList(workspace, path);
}

export async function pluginWorkspaceReadFile(workspace: string, path: string): Promise<ReadFileResult> {
  if (!isTauri) throw new Error("Plugin workspace access is available in the desktop build.");
  return (await getPluginRuntime()).pluginWorkspaceReadFile(workspace, path);
}

export type PluginWorkspaceFileInfo = { path: string; revision: string; sizeBytes: number };
export type PluginWorkspaceFileRange = { path: string; revision: string; offsetBytes: number; nextOffsetBytes: number; totalBytes: number; content: string; eof: boolean };

export async function pluginWorkspaceFileInfo(workspace: string, path: string): Promise<PluginWorkspaceFileInfo> {
  if (!isTauri) throw new Error("Plugin workspace access is available in the desktop build.");
  return (await getPluginRuntime()).pluginWorkspaceFileInfo(workspace, path);
}

export async function pluginWorkspaceReleaseFileRead(workspace: string, path: string, revision: string): Promise<void> {
  if (isTauri) await (await getPluginRuntime()).pluginWorkspaceReleaseFileRead(workspace, path, revision);
}

export async function pluginWorkspaceReadFileRange(workspace: string, path: string, revision: string, offsetBytes: number, maxBytes: number, requestId: string, signal: AbortSignal): Promise<PluginWorkspaceFileRange> {
  if (!isTauri) throw new Error("Plugin workspace access is available in the desktop build.");
  return (await getPluginRuntime()).pluginWorkspaceReadFileRange(workspace, path, revision, offsetBytes, maxBytes, requestId, signal);
}

export async function pluginWorkspaceWriteFile(
  workspace: string,
  path: string,
  content: string,
  expectedFingerprint?: string,
): Promise<PluginWorkspaceWriteResult> {
  if (!isTauri) throw new Error("Plugin workspace access is available in the desktop build.");
  return (await getPluginRuntime()).pluginWorkspaceWriteFile(workspace, path, content, expectedFingerprint);
}

export async function pluginGitDiff(workspace: string, path: string, staged = false): Promise<DiffResult> {
  if (!isTauri) return getGitDiff(workspace, path, staged);
  return (await getPluginRuntime()).pluginGitDiff(workspace, path, staged);
}

export async function authorizePluginNetwork(
  pluginId: string,
  pluginVersion: string,
  workspace: string,
  domain: string,
): Promise<string> {
  if (!isTauri) throw new Error("Plugin network access is available in the desktop build.");
  return (await getPluginRuntime()).authorizePluginNetwork(pluginId, pluginVersion, workspace, domain);
}

export async function pluginNetworkRequest(
  authorizationToken: string,
  workspace: string,
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
): Promise<PluginNetworkResponse> {
  if (!isTauri) throw new Error("Plugin network access is available in the desktop build.");
  return (await getPluginRuntime()).pluginNetworkRequest(authorizationToken, workspace, url, method, headers, body);
}

export async function revokePluginNetwork(pluginId: string, workspace?: string): Promise<void> {
  if (!isTauri) return;
  await (await getPluginRuntime()).revokePluginNetwork(pluginId, workspace);
}

export async function cancelPluginNetworkRequest(authorizationToken: string, workspace: string): Promise<void> {
  if (!isTauri) return;
  await (await getPluginRuntime()).cancelPluginNetworkRequest(authorizationToken, workspace);
}

export type TerminalOutputPayload = {
  sessionId: string;
  seq: number;
  generation: number;
  data: string;
  /** UTF-8 byte length of `data`, measured on the Rust side. */
  bytes: number;
};

export type TerminalExitPayload = {
  sessionId: string;
  status?: string | null;
  exitCode?: number | null;
  signal?: string | null;
};

export async function ackTerminalOutput(sessionId: string, generation: number, upToSeq: number, bytes: number): Promise<void> {
  if (isTauri) await invoke("terminal_ack_output", { sessionId, generation, upToSeq, bytes });
}

export async function listenForTerminalExit(handler: (payload: TerminalExitPayload) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<TerminalExitPayload>("terminal-exit", (event) => handler(event.payload));
}

export async function revealInFileManager(path: string): Promise<void> {
  if (isTauri) await invoke("reveal_in_file_manager", { path });
}

export type AvailableUpdate = {
  version: string;
  notes?: string | null;
};

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isTauri) throw new Error("Updates can only be checked from the desktop app.");
  return invoke<AvailableUpdate | null>("check_for_update");
}

export async function downloadUpdate(): Promise<void> {
  await invoke("download_update");
}

export async function restartToUpdate(): Promise<void> {
  await invoke("restart_to_update");
}

export type LspServerDeclaration = import("../types").PluginLspServer;

export type ResolvedLspServer = {
  workspaceRoot: string;
  serverId: string;
  language: string;
  executablePath: string;
  args: string[];
};

export type LspServerRequest = {
  pluginId: string;
  pluginVersion: string;
  workspaceRoot: string;
  server: LspServerDeclaration;
};

export type LspApprovalRequest = LspServerRequest & {
  expectedExecutablePath: string;
};

export type LspServerIdentity = {
  pluginId: string;
  pluginVersion: string;
  workspaceRoot: string;
  language: string;
};

export type LspEvent =
  | {
      type: "state";
      pluginId: string;
      pluginVersion: string;
      workspaceRoot: string;
      language: string;
      serverId: string;
      state: "started" | "startFailed" | "restarting" | "restartFailed" | "stopped" | "error";
      restartCount: number;
      message: string | null;
    }
  | {
      type: "message";
      pluginId: string;
      pluginVersion: string;
      workspaceRoot: string;
      language: string;
      serverId: string;
      message: Record<string, unknown>;
    }
  | {
      type: "stderr";
      pluginId: string;
      pluginVersion: string;
      workspaceRoot: string;
      language: string;
      serverId: string;
      text: string;
    };

export async function resolveLspServer(
  workspaceRoot: string,
  server: LspServerDeclaration,
): Promise<ResolvedLspServer> {
  if (!isTauri) throw new Error("Language servers are available in the desktop build.");
  return (await getPluginRuntime()).resolveLspServer(workspaceRoot, server);
}

export async function resolvePluginLspServer(
  workspaceRoot: string,
  server: LspServerDeclaration,
): Promise<import("./plugin-authorization").PluginResolvedLspServer> {
  if (!isTauri) throw new Error("Language servers are available in the desktop build.");
  return (await getPluginRuntime()).resolvePluginLspServer(workspaceRoot, server);
}

export async function approveLspServer(request: LspApprovalRequest): Promise<void> {
  if (!isTauri) throw new Error("Language servers are available in the desktop build.");
  await (await getPluginRuntime()).approveLspServer(request);
}

export async function revokeLspServer(request: LspServerRequest): Promise<void> {
  if (!isTauri) return;
  await (await getPluginRuntime()).revokeLspServer(request);
}

/**
 * `lsp-event` is delivered over a per-start channel bound to the
 * owning WebView; the native restart loop reuses the same channel sink.
 */
export async function startLspServer(request: LspServerRequest, onEvent: (event: LspEvent) => void = () => undefined): Promise<void> {
  if (!isTauri) throw new Error("Language servers are available in the desktop build.");
  await (await getPluginRuntime()).startLspServer(request, onEvent);
}

export async function sendLspMessage(
  identity: LspServerIdentity,
  message: Record<string, unknown>,
): Promise<void> {
  if (!isTauri) throw new Error("Language servers are available in the desktop build.");
  await (await getPluginRuntime()).sendLspMessage(identity, message);
}

export async function cancelLspRequest(
  identity: LspServerIdentity,
  requestId: string | number,
): Promise<void> {
  if (!isTauri) throw new Error("Language servers are available in the desktop build.");
  await (await getPluginRuntime()).cancelLspRequest(identity, requestId);
}

export async function stopLspServer(identity: LspServerIdentity): Promise<void> {
  if (!isTauri) return;
  await (await getPluginRuntime()).stopLspServer(identity);
}

export async function stopPluginLsp(pluginId: string): Promise<void> {
  if (!isTauri) return;
  await (await getPluginRuntime()).stopPluginLsp(pluginId);
}

export async function stopWorkspaceLsp(workspaceRoot: string): Promise<void> {
  if (!isTauri) return;
  await (await getPluginRuntime()).stopWorkspaceLsp(workspaceRoot);
}

function findDemoEntry(entry: DirectoryEntry, path: string): DirectoryEntry | undefined {
  if (entry.path === path) return entry;
  for (const child of entry.children ?? []) {
    const found = findDemoEntry(child, path);
    if (found) return found;
  }
  return undefined;
}

function findDemoParent(entry: DirectoryEntry, path: string): DirectoryEntry | undefined {
  if (entry.children?.some((child) => child.path === path)) return entry;
  for (const child of entry.children ?? []) {
    const parent = findDemoParent(child, path);
    if (parent) return parent;
  }
  return undefined;
}

function parentDemoPath(demoWorkspace: string, path: string): string {
  const separator = path.includes("\\") ? "\\" : "/";
  const normalized = path.replace(/[\\/]+$/, "");
  const index = normalized.lastIndexOf(separator);
  return index < 0 ? demoWorkspace : normalized.slice(0, index) || separator;
}

function demoBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

async function renameDemoPath(demo: DemoModules, from: string, to: string) {
  const { demoFiles, demoTree } = demo;
  const entry = findDemoEntry(demoTree, from);
  if (!entry) throw new Error("Unable to rename item. The file no longer exists.");
  const nextName = to.split(/[\\/]/).filter(Boolean).at(-1);
  if (!nextName) throw new Error("Unable to rename item. Enter a valid name.");
  const previousPath = entry.path;
  entry.name = nextName;
  entry.path = to;
  updateDemoDescendantPaths(entry, previousPath, to);
  for (const [path, file] of Object.entries(demoFiles)) {
    if (path !== previousPath && !path.startsWith(`${previousPath}/`)) continue;
    const nextPath = `${to}${path.slice(previousPath.length)}`;
    delete demoFiles[path];
    demoFiles[nextPath] = { ...file, path: nextPath };
  }
}

function updateDemoDescendantPaths(entry: DirectoryEntry, previousPath: string, nextPath: string) {
  for (const child of entry.children ?? []) {
    const childPath = child.path;
    child.path = `${nextPath}${childPath.slice(previousPath.length)}`;
    updateDemoDescendantPaths(child, childPath, child.path);
  }
}
