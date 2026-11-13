import type { GitOperationAction } from "./git-operation-log";
import { t, translatable } from "./i18n";

const actionLabels: Record<GitOperationAction, string> = {
  add: translatable("Stage all"),
  "stage-file": translatable("Stage file"),
  "unstage-file": translatable("Unstage file"),
  "unstage-all": translatable("Unstage all"),
  "discard-file": translatable("Discard change"),
  "discard-untracked-file": translatable("Discard untracked file"),
  commit: translatable("Commit"),
  "commit-all": translatable("Stage all and commit"),
  push: translatable("Push"),
  pull: translatable("Pull"),
  stash: translatable("Stash"),
  "stash-pop": translatable("Stash pop"),
  "stash-apply": translatable("Apply stash"),
  "stash-drop": translatable("Drop stash"),
  switch: translatable("Switch branch"),
  "create-branch": translatable("Create branch"),
  "delete-branch": translatable("Delete branch"),
  "create-worktree": translatable("Create worktree"),
};

export const gitActionLabel = (action: GitOperationAction) => t(actionLabels[action]);
