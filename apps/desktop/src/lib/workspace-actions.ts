import { canonicalizeWorkspaceRoot, isTauri, openFolder, openWorkspaceFileDialog, readWorkspaceFile, saveWorkspaceFileDialog, writeWorkspaceFile } from "./bridge";
import { errorMessage } from "./core";
import { runtimePathOptions, samePath, wireBasename } from "./path-identity";
import { workspaceFileName } from "./workspace-folders";
import { t } from "./i18n";

/**
 * What the workspace commands need from the app. The commands themselves load
 * on first use so the startup bundle stays small.
 */
export type WorkspaceActionHost = {
  folders: () => string[];
  workspaceFile: () => string | undefined;
  workspaceName: () => string;
  /** False while the window is busy, closing or still starting. */
  canChangeWorkspace: () => boolean;
  /** A check that turns false once the user switches project tabs. */
  captureCurrent: () => () => boolean;
  notify: (message: string) => void;
  openFolderInNewTab: () => Promise<void>;
  /** Show these folders in the active project tab and list the new ones; the first folder keeps Git and terminals. */
  setFolders: (folders: string[]) => void;
  /** Hand Git, terminals and plugins to a new first folder, as when switching project tabs. */
  switchFirstFolder: (folders: string[]) => Promise<boolean>;
  setWorkspaceFile: (path: string) => void;
  /** Switch to the project tab of this workspace file, or open a new one. */
  openWorkspaceTab: (path: string, folders: string[]) => Promise<boolean>;
  rememberWorkspaceFile: (path: string) => void;
};

export function createWorkspaceActions(host: WorkspaceActionHost) {
  const pathOptions = runtimePathOptions();
  const sameFolder = (left: string, right: string) => samePath(left, right, pathOptions);

  /** Rewrite the workspace file after its folders change, so the file always matches the tab. */
  const saveFolders = async () => {
    const file = host.workspaceFile();
    if (!file || !isTauri) return;
    try {
      await writeWorkspaceFile(file, host.folders());
    } catch (error) {
      host.notify(errorMessage(error, "The workspace file could not be updated."));
    }
  };

  const addFolder = async () => {
    if (!host.canChangeWorkspace()) return;
    if (!host.folders().length) {
      await host.openFolderInNewTab();
      return;
    }
    const isCurrent = host.captureCurrent();
    try {
      const selected = await openFolder();
      if (!selected || !isCurrent()) return;
      const folder = await canonicalizeWorkspaceRoot(selected);
      if (!isCurrent()) return;
      const name = wireBasename(folder, pathOptions);
      if (host.folders().some((item) => sameFolder(item, folder))) {
        host.notify(t("{name} is already in this workspace.", { name }));
        return;
      }
      host.setFolders([...host.folders(), folder]);
      void saveFolders();
      host.notify(t("Added {name} to the workspace", { name }));
    } catch (error) {
      host.notify(errorMessage(error, "Unable to add the folder to the workspace."));
    }
  };

  const removeFolder = async (folder: string) => {
    const folders = host.folders();
    const remaining = folders.filter((item) => !sameFolder(item, folder));
    if (folders.length < 2 || remaining.length === folders.length) return;
    if (sameFolder(folder, folders[0])) {
      if (!await host.switchFirstFolder(remaining)) return;
    } else {
      host.setFolders(remaining);
    }
    void saveFolders();
  };

  const saveAs = async () => {
    if (!host.folders().length) {
      host.notify(t("Open a folder before saving a workspace."));
      return;
    }
    if (!isTauri) {
      host.notify(t("Workspace files are available in the desktop build."));
      return;
    }
    const isCurrent = host.captureCurrent();
    try {
      const destination = await saveWorkspaceFileDialog(`${host.workspaceName() || "workspace"}.pdw`);
      if (!destination || !isCurrent()) return;
      await writeWorkspaceFile(destination, host.folders());
      host.setWorkspaceFile(destination);
      host.rememberWorkspaceFile(destination);
      host.notify(t("Saved workspace {name}", { name: workspaceFileName(destination, pathOptions) }));
    } catch (error) {
      host.notify(errorMessage(error, "Unable to save the workspace file."));
    }
  };

  const open = async (path: string) => {
    try {
      const file = await readWorkspaceFile(path);
      if (!file.folders.length) throw new Error(t("None of the folders in {name} exist anymore.", { name: file.name }));
      if (!await host.openWorkspaceTab(file.path, file.folders)) return;
      host.rememberWorkspaceFile(file.path);
      host.notify(file.missing.length
        ? t("Opened {name}. Folders not found: {folders}", { name: file.name, folders: file.missing.join(", ") })
        : t("Opened workspace {name}", { name: file.name }));
    } catch (error) {
      host.notify(errorMessage(error, "Unable to open the workspace."));
    }
  };

  const openFromDialog = async () => {
    if (!isTauri) {
      host.notify(t("Workspace files are available in the desktop build."));
      return;
    }
    try {
      const selected = await openWorkspaceFileDialog();
      if (selected) await open(selected);
    } catch (error) {
      host.notify(errorMessage(error, "Unable to open the workspace."));
    }
  };

  return { addFolder, removeFolder, saveAs, open, openFromDialog };
}

export type WorkspaceActions = ReturnType<typeof createWorkspaceActions>;
