export function defaultGitWorktreePath(repositoryRoot: string, branchName: string): string {
  const root = repositoryRoot.replace(/[\\/]+$/, "");
  const separator = root.includes("\\") ? "\\" : "/";
  const parentIndex = Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\"));
  const parent = parentIndex < 0 ? "" : root.slice(0, parentIndex);
  const repositoryName = parentIndex < 0 ? root : root.slice(parentIndex + 1);
  const prefix = separator === "/" && parentIndex === 0 ? "/" : parent ? `${parent}${separator}` : "";
  const branchSlug = branchName.trim().replaceAll("/", "-").replace(/[\\:*?"<>|]/g, "-").replace(/\s+/g, "-") || "new-branch";
  return `${prefix}${repositoryName || "repository"}-worktree-${branchSlug}`;
}
