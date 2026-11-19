import type { GitCommitFile, GitFileStatus, GitStashFile, ImageDiffVersions } from "../types";

const STAGED = "";

export function workingImageDiff(file: GitFileStatus, staged: boolean, untracked: boolean): ImageDiffVersions {
  if (staged)
    return {
      before:
        file.indexStatus === "A"
          ? undefined
          : {
              kind: "git",
              revision: "HEAD",
              path: file.originalPath ?? file.path,
            },
      after: file.indexStatus === "D" ? undefined : { kind: "git", revision: STAGED, path: file.path },
    };
  return {
    before: untracked ? undefined : { kind: "git", revision: STAGED, path: file.path },
    after: file.worktreeStatus === "D" ? undefined : { kind: "worktree", path: file.path },
  };
}

export function commitImageDiff(commit: string, file: GitCommitFile): ImageDiffVersions {
  const status = file.status.charAt(0);
  return {
    before:
      status === "A"
        ? undefined
        : {
            kind: "git",
            revision: `${commit}^`,
            path: file.originalPath ?? file.path,
          },
    after: status === "D" ? undefined : { kind: "git", revision: commit, path: file.path },
  };
}

/** A stash commit holds the working tree; its first parent is the base and its third parent the untracked files. */
export function stashImageDiff(stash: string, file: GitStashFile): ImageDiffVersions {
  if (file.untracked) return { after: { kind: "git", revision: `${stash}^3`, path: file.path } };
  const status = file.status.charAt(0);
  return {
    before:
      status === "A"
        ? undefined
        : {
            kind: "git",
            revision: `${stash}^1`,
            path: file.originalPath ?? file.path,
          },
    after: status === "D" ? undefined : { kind: "git", revision: stash, path: file.path },
  };
}
