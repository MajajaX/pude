import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./bridge";
import { isSameOrDescendantPath, runtimePathOptions, wireBasename } from "./path-identity";

export type ProjectSearchOptions = {
  query: string;
  mode: "content" | "files";
  caseSensitive: boolean;
  includeIgnored: boolean;
};

export type ProjectSearchMatch = {
  path: string;
  relativePath: string;
  line?: number | null;
  preview?: string | null;
};

export type ProjectSearchResults = {
  matches: ProjectSearchMatch[];
  truncated: boolean;
  skippedFiles: number;
};

export type ProjectReplaceOptions = {
  query: string;
  replacement: string;
  caseSensitive: boolean;
  includeIgnored: boolean;
  /** Limit the replacement to these files; every matching file changes otherwise. */
  paths?: string[];
  /** Files with unsaved editor changes, which are never rewritten. */
  skipPaths: string[];
};

export type ProjectReplaceResults = {
  changedFiles: string[];
  replacements: number;
  skippedUnsaved: number;
  failedFiles: Array<{ path: string; message: string }>;
  truncated: boolean;
};

const MAX_COMBINED_RESULTS = 300;

/**
 * Search each workspace folder in turn. With several folders, relative paths
 * start with the folder name so results from different folders stay apart.
 */
export async function searchProjectFolders(folders: readonly string[], options: ProjectSearchOptions, requestId: string, isCurrent: () => boolean): Promise<ProjectSearchResults> {
  const combined: ProjectSearchResults = { matches: [], truncated: false, skippedFiles: 0 };
  for (const folder of folders) {
    if (!isCurrent()) break;
    const result = await searchProject(folder, options, requestId);
    const prefix = folders.length > 1 ? `${wireBasename(folder, runtimePathOptions())}/` : "";
    combined.matches.push(...result.matches.map((match) => ({ ...match, relativePath: `${prefix}${match.relativePath}` })));
    combined.truncated ||= result.truncated;
    combined.skippedFiles += result.skippedFiles;
    if (combined.matches.length >= MAX_COMBINED_RESULTS) {
      combined.matches.length = MAX_COMBINED_RESULTS;
      combined.truncated = true;
      break;
    }
  }
  return combined;
}

export async function replaceInProject(workspace: string, options: ProjectReplaceOptions): Promise<ProjectReplaceResults> {
  if (!isTauri) throw new Error("Replacing across files is available in the desktop build.");
  return invoke<ProjectReplaceResults>("replace_in_project", { workspace, options: { ...options, paths: options.paths ?? null } });
}

export function replaceSummary(result: ProjectReplaceResults): string {
  const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
  const summary = [`Replaced ${count(result.replacements, "match", "matches")} in ${count(result.changedFiles.length, "file", "files")}.`];
  if (result.skippedUnsaved) summary.push(`Skipped ${count(result.skippedUnsaved, "file", "files")} with unsaved changes.`);
  if (result.failedFiles.length) summary.push(`${count(result.failedFiles.length, "file", "files")} could not be changed: ${result.failedFiles[0].message}`);
  if (result.truncated) summary.push("Some files were not checked because the project is very large.");
  return summary.join(" ");
}

/** Replace in each workspace folder; listed paths only reach the folder that contains them. */
export async function replaceInProjectFolders(folders: readonly string[], options: ProjectReplaceOptions): Promise<ProjectReplaceResults> {
  const combined: ProjectReplaceResults = { changedFiles: [], replacements: 0, skippedUnsaved: 0, failedFiles: [], truncated: false };
  const pathOptions = runtimePathOptions();
  for (const folder of folders) {
    const paths = options.paths?.filter((path) => isSameOrDescendantPath(path, folder, pathOptions));
    if (paths && !paths.length) continue;
    const result = await replaceInProject(folder, { ...options, paths });
    combined.changedFiles.push(...result.changedFiles);
    combined.replacements += result.replacements;
    combined.skippedUnsaved += result.skippedUnsaved;
    combined.failedFiles.push(...result.failedFiles);
    combined.truncated ||= result.truncated;
  }
  return combined;
}

export async function searchProject(workspace: string, options: ProjectSearchOptions, requestId: string): Promise<ProjectSearchResults> {
  if (isTauri) return invoke<ProjectSearchResults>("search_project", { workspace, options, requestId });
  const { demoTree, demoFiles } = await import("./demo");
  const result: ProjectSearchResults = { matches: [], truncated: false, skippedFiles: 0 };
  const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
  const matches = (text: string) => (options.caseSensitive ? text : text.toLowerCase()).includes(needle);
  const pending = [...(demoTree.children ?? [])];
  while (pending.length) {
    const entry = pending.shift()!;
    if (entry.children) pending.push(...entry.children);
    if (entry.kind !== "file" || !entry.path.startsWith(`${workspace}/`)) continue;
    const relativePath = entry.path.slice(workspace.length + 1);
    if (options.mode === "files") {
      if (matches(relativePath)) result.matches.push({ path: entry.path, relativePath });
    } else {
      const content = demoFiles[entry.path]?.content;
      if (content === undefined) { result.skippedFiles += 1; continue; }
      content.split("\n").forEach((line, index) => {
        if (matches(line)) result.matches.push({ path: entry.path, relativePath, line: index + 1, preview: line.slice(0, 240) });
      });
    }
  }
  return result;
}

export async function cancelProjectSearch(requestId: string): Promise<void> {
  if (isTauri) await invoke("cancel_project_search", { requestId });
}
