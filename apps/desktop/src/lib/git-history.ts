import type { GitBranch, GitCommit } from "../types";

function branchNameFromRef(reference: string): string {
  const trimmed = reference.trim();
  return trimmed.startsWith("HEAD -> ") ? trimmed.slice("HEAD -> ".length) : trimmed;
}

export function filterGitCommitsByBranches(
  commits: GitCommit[],
  branches: GitBranch[],
  selectedBranchNames: string[],
): GitCommit[] {
  const availableBranches = new Set(branches.map((branch) => branch.name));
  const selectedBranches = new Set(selectedBranchNames.filter((name) => availableBranches.has(name)));
  const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const branchHeads = new Set<string>();

  for (const commit of commits) {
    if (commit.refs.some((reference) => selectedBranches.has(branchNameFromRef(reference)))) {
      branchHeads.add(commit.hash);
    }
  }

  const reachableHashes = new Set<string>();
  const visit = (hash: string) => {
    if (reachableHashes.has(hash)) return;
    const commit = commitsByHash.get(hash);
    if (!commit) return;
    reachableHashes.add(hash);
    for (const parent of commit.parents ?? []) visit(parent);
  };

  for (const head of branchHeads) visit(head);

  return commits.filter((commit) => reachableHashes.has(commit.hash));
}

export function getVisibleGitCommitParents(commit: GitCommit, visibleCommitHashes: ReadonlySet<string>): string[] {
  return (commit.parents ?? []).filter((parent) => visibleCommitHashes.has(parent));
}
