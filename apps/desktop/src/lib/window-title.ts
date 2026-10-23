import { wireBasename, type PathIdentityOptions } from "./path-identity";

export const DEFAULT_WINDOW_TITLE = "pude — pure code editor";

/** Title shown for a window: `pude - <folder>` once a folder is open, or the workspace name. */
export function windowTitleForWorkspace(workspace: string, options: PathIdentityOptions = {}, workspaceName?: string): string {
  const folderName = workspaceName || (workspace ? wireBasename(workspace, options) : "");
  return folderName ? `pude - ${folderName}` : DEFAULT_WINDOW_TITLE;
}
