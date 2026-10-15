export type GitHistoryBranchFilter = "all" | "current-head" | `branch:${"local" | "remote"}:${string}`;

export type GitHistoryFilterOption = {
  value: GitHistoryBranchFilter;
};

export type GitHistoryFilterReconciliation = {
  selected: GitHistoryBranchFilter;
  repositoryRoot: string;
};

/**
 * Keep a selected history filter usable while Git replaces repository data.
 *
 * Repository identity changes take precedence so a selection from another
 * checkout can never hide the new repository's first page. During a history
 * request the branch list can briefly describe the previous snapshot, so an
 * absent option is only cleared after loading settles.
 */
export function reconcileGitHistoryBranchFilter(input: {
  selected: GitHistoryBranchFilter;
  previousRepositoryRoot: string;
  repositoryRoot: string;
  loading: boolean;
  options: readonly GitHistoryFilterOption[];
}): GitHistoryFilterReconciliation {
  if (input.repositoryRoot !== input.previousRepositoryRoot) {
    return { selected: "all", repositoryRoot: input.repositoryRoot };
  }
  if (input.loading || input.selected === "all") {
    return { selected: input.selected, repositoryRoot: input.repositoryRoot };
  }
  if (input.options.some((option) => option.value === input.selected)) {
    return { selected: input.selected, repositoryRoot: input.repositoryRoot };
  }
  return { selected: "all", repositoryRoot: input.repositoryRoot };
}
