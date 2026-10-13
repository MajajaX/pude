import { wireBasename, wireParentPath } from "./path-identity";

export type ProjectTab = { id: string; workspace: string; label: string; dirty: boolean };

export function projectTabLabel(project: Pick<ProjectTab, "workspace">, projects: readonly Pick<ProjectTab, "workspace">[]): string {
  if (!project.workspace) return "Files";
  const name = wireBasename(project.workspace);
  const duplicates = projects.filter((item) => item.workspace && wireBasename(item.workspace) === name);
  return duplicates.length > 1 ? `${name} — ${wireBasename(wireParentPath(project.workspace))}` : name;
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
