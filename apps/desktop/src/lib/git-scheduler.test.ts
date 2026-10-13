import { describe, expect, it } from "vitest";
import { classifyGitChanges, classifyGitChange, gitRefreshDelay } from "./git-scheduler";

describe("Git dirty scope classification", () => {
  it("keeps ordinary worktree changes in status scope", () => {
    expect(classifyGitChanges([{ kind: "modify", path: "/repo/src/main.ts" }], "/repo")).toEqual({ status: true, branches: false, history: false });
  });

  it("uses native git root classification without assuming a .git path", () => {
    const commonDir = { path: "/shared/git", kind: "commonDir" as const };
    expect(classifyGitChange({ kind: "modify", path: "/shared/git/refs/heads/main", source: "commonDir" }, "/repo", [commonDir])).toEqual({ status: true, branches: true, history: true });
  });

  it("escalates unknown metadata conservatively", () => {
    expect(classifyGitChange({ kind: "rescan", path: "/repo", source: "gitDir" }, "/repo", [{ path: "/repo/.git", kind: "gitDir" }])).toEqual({ status: true, branches: true, history: true });
  });

  it("refreshes status when refs move because HEAD may point at the changed ref", () => {
    expect(classifyGitChange({ kind: "modify", path: "/repo/.git/refs/heads/main", source: "gitDir" }, "/repo", [{ path: "/repo/.git", kind: "gitDir" }])).toEqual({ status: true, branches: true, history: true });
  });

  it("keeps the current branch status dirty for an explicitly classified ref", () => {
    expect(classifyGitChange({ kind: "modify", path: "/repo/.git/refs/heads/main", gitScopes: ["refs"] }, "/repo")).toEqual({ status: true, branches: true, history: true });
  });
});

describe("Git refresh visibility throttling", () => {
  it("allows visible panels to settle sooner than hidden panels", () => {
    expect(gitRefreshDelay(true, 10_000, 10_000)).toBe(220);
    expect(gitRefreshDelay(false, 10_000, 10_000)).toBe(1_200);
    expect(gitRefreshDelay(true, 10_900, 10_000)).toBe(100);
  });
});
