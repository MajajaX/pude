import type { DirectoryEntry } from "../types";
import { addToGitignore } from "./bridge";
import { t } from "./i18n";
import {
  isSameOrDescendantPath,
  joinWirePath,
  runtimePathOptions,
  samePath,
  type PathIdentityOptions,
} from "./path-identity";

export function canAddToGitignore(
  path: string,
  repositoryRoot: string,
  options: PathIdentityOptions = runtimePathOptions(),
): boolean {
  return (
    Boolean(repositoryRoot) &&
    isSameOrDescendantPath(path, repositoryRoot, options) &&
    !samePath(path, repositoryRoot, options) &&
    !isSameOrDescendantPath(path, joinWirePath(repositoryRoot, ".git", options), options)
  );
}

export async function addEntryToGitignore(workspace: string, entry: DirectoryEntry): Promise<string> {
  const { name } = entry;
  const { added, tracked } = await addToGitignore(workspace, entry.path);
  if (added) {
    return tracked
      ? t("Added {name} to .gitignore. Git keeps tracking it until it is removed with git rm --cached.", { name })
      : t("Added {name} to .gitignore", { name });
  }
  return tracked
    ? t("{name} is already in .gitignore. Git keeps tracking it until it is removed with git rm --cached.", { name })
    : t("{name} is already in .gitignore", { name });
}
