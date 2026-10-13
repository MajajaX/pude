import { describe, expect, it } from "vitest";
import { defaultGitWorktreePath } from "./git-worktree";

describe("default Git worktree path", () => {
  it("keeps a POSIX root prefix for repositories directly under /", () => {
    expect(defaultGitWorktreePath("/foo", "feature/search")).toBe("/foo-worktree-feature-search");
  });

  it("uses the repository parent for a regular POSIX path", () => {
    expect(defaultGitWorktreePath("/workspace/foo", "feature/search")).toBe("/workspace/foo-worktree-feature-search");
  });

  it("preserves Windows drive separators", () => {
    expect(defaultGitWorktreePath("C:\\Users\\example\\foo", "feature/search")).toBe("C:\\Users\\example\\foo-worktree-feature-search");
  });
});
