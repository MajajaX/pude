import type { DirectoryEntry } from "../types";
import { t } from "./i18n";
import { isSameOrDescendantPath, pathComparisonKey, wireBasename, type PathIdentityOptions } from "./path-identity";

/** Path of the Explorer row that groups the folders of a multi-folder workspace. */
export const WORKSPACE_ROOT_PATH = "pude://workspace";
export const WORKSPACE_FILE_EXTENSION = ".pdw";

export function isWorkspaceRootEntry(entry: Pick<DirectoryEntry, "path">): boolean {
  return entry.path === WORKSPACE_ROOT_PATH;
}

export function isWorkspaceFilePath(path: string): boolean {
  return path.toLowerCase().endsWith(WORKSPACE_FILE_EXTENSION);
}

/** A workspace file's name without `.pdw`. */
export function workspaceFileName(path: string, options: PathIdentityOptions = {}): string {
  const name = wireBasename(path, options);
  return isWorkspaceFilePath(name) ? name.slice(0, -WORKSPACE_FILE_EXTENSION.length) : name;
}

/** Name shown for a project: the workspace file, `folder +N` for unsaved workspaces, or the folder. */
export function workspaceLabel(folders: readonly string[], workspaceFile: string | undefined, options: PathIdentityOptions = {}): string {
  if (workspaceFile) return workspaceFileName(workspaceFile, options);
  if (!folders.length) return "";
  const name = wireBasename(folders[0], options);
  return folders.length > 1 ? `${name} +${folders.length - 1}` : name;
}

/**
 * Explorer root for a project. One folder is its own root; several folders
 * sit under a workspace row so each keeps its own tree. Existing folder
 * entries are reused so expanded state survives adding or removing folders.
 */
export function makeWorkspaceRoot(folders: readonly string[], label: string, previous: DirectoryEntry | undefined, options: PathIdentityOptions = {}): DirectoryEntry {
  const existing = new Map(workspaceRootFolders(previous).map((entry) => [pathComparisonKey(entry.path, options), entry]));
  const folderEntry = (path: string): DirectoryEntry => existing.get(pathComparisonKey(path, options))
    ?? { name: wireBasename(path, options), path, kind: "directory", expanded: true, loaded: false };
  if (folders.length === 1) return folderEntry(folders[0]);
  return {
    name: t("{name} (Workspace)", { name: label }), path: WORKSPACE_ROOT_PATH, kind: "directory",
    expanded: previous && isWorkspaceRootEntry(previous) ? previous.expanded : true, loaded: true,
    children: folders.map(folderEntry),
  };
}

export function workspaceRootFolders(root: DirectoryEntry | undefined): DirectoryEntry[] {
  if (!root) return [];
  return isWorkspaceRootEntry(root) ? root.children ?? [] : [root];
}

/** The workspace folder that contains `path`; the deepest one when folders are nested. */
export function folderContaining(path: string, folders: readonly string[], options: PathIdentityOptions = {}): string | undefined {
  return folders
    .filter((folder) => isSameOrDescendantPath(path, folder, options))
    .sort((left, right) => right.length - left.length)[0];
}

/** Workspace-relative watcher excludes apply to every folder of the workspace. */
export function watcherExcludesForFolders(excludes: readonly string[], folders: readonly string[], join: (folder: string, path: string) => string): string[] {
  const isAbsolute = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  const relative = excludes.filter((exclude) => !isAbsolute(exclude));
  return [...excludes, ...folders.slice(1).flatMap((folder) => relative.map((exclude) => join(folder, exclude)))];
}
