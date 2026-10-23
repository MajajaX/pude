import { wireBasename, wireParentPath } from "./path-identity";
import { workspaceLabel } from "./workspace-folders";
import { t } from "./i18n";

export type ProjectTab = { id: string; workspace: string; label: string; title: string; dirty: boolean };
type ProjectLabelSource = { workspace: string; additionalFolders?: readonly string[]; workspaceFile?: string };

const projectName = (project: ProjectLabelSource) => workspaceLabel([project.workspace, ...(project.additionalFolders ?? [])], project.workspaceFile);

export function projectTabLabel(project: ProjectLabelSource, projects: readonly ProjectLabelSource[]): string {
  if (!project.workspace) return t("Files");
  const name = projectName(project);
  const duplicates = projects.filter((item) => item.workspace && projectName(item) === name);
  return duplicates.length > 1 ? `${name} — ${wireBasename(wireParentPath(project.workspaceFile ?? project.workspace))}` : name;
}

/** Tooltip: the workspace file and every folder, one per line. */
export function projectTabTitle(project: ProjectLabelSource): string {
  if (!project.workspace) return t("Files");
  return [project.workspaceFile, project.workspace, ...(project.additionalFolders ?? [])].filter(Boolean).join("\n");
}

export function projectAfterClose(ids: readonly string[], activeId: string | undefined, closedId: string): string | undefined {
  if (activeId !== closedId) return activeId;
  const index = ids.indexOf(closedId);
  return index < 0 ? activeId : ids[index + 1] ?? ids[index - 1];
}

export function reorderProjects<T extends { id: string }>(projects: readonly T[], sourceId: string, targetId: string): T[] {
  const result = [...projects];
  const source = result.findIndex((project) => project.id === sourceId);
  const target = result.findIndex((project) => project.id === targetId);
  if (source < 0 || target < 0 || source === target) return result;
  const [moved] = result.splice(source, 1);
  result.splice(target, 0, moved);
  return result;
}
