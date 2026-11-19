import { describe, expect, it } from "vitest";
import { commitImageDiff, stashImageDiff, workingImageDiff } from "./image-diff";

const commit = "a".repeat(40);

describe("image diff versions", () => {
  it("compares a staged image with HEAD, following a rename", () => {
    expect(
      workingImageDiff(
        { path: "new.png", originalPath: "old.png", indexStatus: "R", worktreeStatus: null },
        true,
        false,
      ),
    ).toEqual({
      before: { kind: "git", revision: "HEAD", path: "old.png" },
      after: { kind: "git", revision: "", path: "new.png" },
    });
  });

  it("has no before side for an added or untracked image and no after side for a deleted one", () => {
    expect(
      workingImageDiff({ path: "a.png", indexStatus: "A", worktreeStatus: null }, true, false).before,
    ).toBeUndefined();
    expect(workingImageDiff({ path: "a.png", indexStatus: null, worktreeStatus: "?" }, false, true)).toEqual({
      after: { kind: "worktree", path: "a.png" },
    });
    expect(workingImageDiff({ path: "a.png", indexStatus: null, worktreeStatus: "D" }, false, false)).toEqual({
      before: { kind: "git", revision: "", path: "a.png" },
    });
  });

  it("compares an unstaged image on disk with the staged copy", () => {
    expect(workingImageDiff({ path: "a.png", indexStatus: null, worktreeStatus: "M" }, false, false)).toEqual({
      before: { kind: "git", revision: "", path: "a.png" },
      after: { kind: "worktree", path: "a.png" },
    });
  });

  it("compares a commit with its parent", () => {
    expect(commitImageDiff(commit, { path: "a.png", status: "M" })).toEqual({
      before: { kind: "git", revision: `${commit}^`, path: "a.png" },
      after: { kind: "git", revision: commit, path: "a.png" },
    });
    expect(commitImageDiff(commit, { path: "a.png", status: "D" }).after).toBeUndefined();
  });

  it("reads a stash's untracked image from its third parent", () => {
    expect(stashImageDiff(commit, { path: "a.png", status: "A", untracked: true })).toEqual({
      after: { kind: "git", revision: `${commit}^3`, path: "a.png" },
    });
    expect(stashImageDiff(commit, { path: "a.png", status: "M", untracked: false })).toEqual({
      before: { kind: "git", revision: `${commit}^1`, path: "a.png" },
      after: { kind: "git", revision: commit, path: "a.png" },
    });
  });
});
