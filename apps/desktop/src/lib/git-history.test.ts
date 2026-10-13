import { describe, expect, it } from "vitest";
import { filterGitCommitsByBranches, getVisibleGitCommitParents } from "./git-history";
import { demoGit } from "./demo";
import type { GitBranch, GitCommit } from "../types";

const branches: GitBranch[] = [
  { name: "main", current: true },
  { name: "feature/search", current: false },
];

const commits: GitCommit[] = [
  { hash: "main-tip", parents: ["shared"], shortHash: "main-tip", author: "A", date: "2026-09-25", subject: "main", refs: ["HEAD -> main"], files: [] },
  { hash: "feature-tip", parents: ["shared"], shortHash: "feature-tip", author: "A", date: "2026-09-24", subject: "feature", refs: ["feature/search"], files: [] },
  { hash: "shared", parents: ["root"], shortHash: "shared", author: "A", date: "2026-09-23", subject: "shared", refs: [], files: [] },
  { hash: "root", parents: [], shortHash: "root", author: "A", date: "2026-09-22", subject: "root", refs: [], files: [] },
];

describe("Git history branch filtering", () => {
  it("includes selected branch commits and their real ancestors", () => {
    expect(filterGitCommitsByBranches(commits, branches, ["feature/search"]).map((commit) => commit.hash)).toEqual([
      "feature-tip",
      "shared",
      "root",
    ]);
  });

  it("keeps shared ancestry when multiple branches are selected", () => {
    expect(filterGitCommitsByBranches(commits, branches, ["main", "feature/search"]).map((commit) => commit.hash)).toEqual([
      "main-tip",
      "feature-tip",
      "shared",
      "root",
    ]);
  });

  it("shows the demo feature branch tip and its shared ancestry", () => {
    const demoBranches: GitBranch[] = [
      { name: "main", current: true },
      { name: "feature/editor-tabs", current: false },
    ];
    expect(filterGitCommitsByBranches(demoGit.commits, demoBranches, ["feature/editor-tabs"]).map((commit) => commit.hash)).toEqual([
      "4c2f7d0e8a6b1c3d5e7f90123456789abcdef012",
      "3a5e8c0b2d4f6a8c1e3f5b7d9a0c2e4f6b8d1a3c",
    ]);
  });

  it("returns no commits when no branches are selected", () => {
    expect(filterGitCommitsByBranches(commits, branches, [])).toEqual([]);
  });

  it("does not create graph lanes for parents outside the visible history cutoff", () => {
    const truncatedTip = { ...commits[0], parents: ["older-but-not-loaded"] };
    expect(getVisibleGitCommitParents(truncatedTip, new Set([truncatedTip.hash]))).toEqual([]);
  });

  it("does not create graph lanes for parents hidden by branch selection", () => {
    const featureOnly = filterGitCommitsByBranches(commits, branches, ["feature/search"]);
    const featureHashes = new Set(featureOnly.map((commit) => commit.hash));
    const merge = { ...commits[1], parents: ["main-tip", "shared"] };
    expect(getVisibleGitCommitParents(merge, featureHashes)).toEqual(["shared"]);
  });
});
