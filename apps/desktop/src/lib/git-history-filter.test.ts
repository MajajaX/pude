import { describe, expect, it } from "vitest";
import { reconcileGitHistoryBranchFilter, type GitHistoryBranchFilter } from "./git-history-filter";

const option = (value: GitHistoryBranchFilter) => ({ value });

describe("Git history branch filter reconciliation", () => {
  it("resets a selection when the repository identity changes", () => {
    expect(reconcileGitHistoryBranchFilter({
      selected: "branch:local:feature-a",
      previousRepositoryRoot: "/repo-a",
      repositoryRoot: "/repo-b",
      loading: true,
      options: [option("branch:local:feature-a")],
    })).toEqual({ selected: "all", repositoryRoot: "/repo-b" });
  });

  it("keeps a missing selection while the replacement history is loading", () => {
    expect(reconcileGitHistoryBranchFilter({
      selected: "branch:local:feature-a",
      previousRepositoryRoot: "/repo",
      repositoryRoot: "/repo",
      loading: true,
      options: [option("branch:local:main")],
    })).toEqual({ selected: "branch:local:feature-a", repositoryRoot: "/repo" });
  });

  it("resets a missing selection after loading settles", () => {
    expect(reconcileGitHistoryBranchFilter({
      selected: "branch:local:feature-a",
      previousRepositoryRoot: "/repo",
      repositoryRoot: "/repo",
      loading: false,
      options: [option("branch:local:main")],
    })).toEqual({ selected: "all", repositoryRoot: "/repo" });
  });

  it("keeps an available selection", () => {
    expect(reconcileGitHistoryBranchFilter({
      selected: "current-head",
      previousRepositoryRoot: "/repo",
      repositoryRoot: "/repo",
      loading: false,
      options: [option("current-head")],
    })).toEqual({ selected: "current-head", repositoryRoot: "/repo" });
  });
});
