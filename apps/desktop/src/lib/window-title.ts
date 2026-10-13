import { wireBasename, type PathIdentityOptions } from "./path-identity";

export const DEFAULT_WINDOW_TITLE = "pude — pure code editor";

/** Title shown for a window: `pude - <folder>` once a folder is open. */
export function windowTitleForWorkspace(workspace: string, options: PathIdentityOptions = {}): string {
  const folderName = workspace ? wireBasename(workspace, options) : "";
  return folderName ? `pude - ${folderName}` : DEFAULT_WINDOW_TITLE;
}
