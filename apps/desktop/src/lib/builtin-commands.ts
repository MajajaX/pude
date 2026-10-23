import { translatable } from "./i18n";
import type { CommandPaletteItem } from "./plugin-activation";

// The built-in command list must be available before the lazily-loaded
// plugin host (the palette can be opened on a fresh install with no plugins),
// so it lives in this tiny static module instead of plugin-activation.
export const BUILTIN_COMMANDS: CommandPaletteItem[] = [
  { id: "pude.builtin.openFile", title: translatable("File: Open File…"), source: "builtin", detail: translatable("Open a file") },
  { id: "pude.builtin.openFolder", title: translatable("File: Open Folder…"), source: "builtin", detail: translatable("Open a folder in a new project tab") },
  { id: "pude.builtin.openWorkspace", title: translatable("File: Open Workspace from File…"), source: "builtin", detail: translatable("Open a saved .pdw workspace") },
  { id: "pude.builtin.addFolderToWorkspace", title: translatable("Workspaces: Add Folder to Workspace…"), source: "builtin", detail: translatable("Show another folder in this project tab") },
  { id: "pude.builtin.saveWorkspaceAs", title: translatable("Workspaces: Save Workspace As…"), source: "builtin", detail: translatable("Save this tab's folders as a .pdw file") },
  { id: "pude.builtin.save", title: translatable("File: Save"), source: "builtin", detail: translatable("Save the active file") },
  { id: "pude.builtin.saveAs", title: translatable("File: Save As…"), source: "builtin", detail: translatable("Save the active file to a new path") },
  { id: "pude.builtin.find", title: translatable("Edit: Find"), source: "builtin", detail: translatable("Find text in the active file") },
  { id: "pude.builtin.replace", title: translatable("Edit: Replace"), source: "builtin", detail: translatable("Find and replace text") },
  { id: "pude.builtin.toggleTerminal", title: translatable("Terminal: Toggle Panel"), source: "builtin", detail: translatable("Show or hide the terminal") },
  { id: "pude.builtin.managePlugins", title: translatable("Plugins: Manage Plugins"), source: "builtin", detail: translatable("View and enable installed plugins") },
];
