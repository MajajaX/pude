import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./bridge";

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
    if (entry.kind !== "file") continue;
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
