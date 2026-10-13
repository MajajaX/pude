import type { CommandPaletteItem } from "./plugin-activation";

// The built-in command list must be available before the lazily-loaded
// plugin host (the palette can be opened on a fresh install with no plugins),
// so it lives in this tiny static module instead of plugin-activation.
export const BUILTIN_COMMANDS: CommandPaletteItem[] = [
  { id: "pude.builtin.openFile", title: "File: Open File…", source: "builtin", detail: "Open a file" },
  { id: "pude.builtin.openFolder", title: "File: Open Folder…", source: "builtin", detail: "Open a workspace" },
  { id: "pude.builtin.save", title: "File: Save", source: "builtin", detail: "Save the active file" },
  { id: "pude.builtin.saveAs", title: "File: Save As…", source: "builtin", detail: "Save the active file to a new path" },
  { id: "pude.builtin.find", title: "Edit: Find", source: "builtin", detail: "Find text in the active file" },
  { id: "pude.builtin.replace", title: "Edit: Replace", source: "builtin", detail: "Find and replace text" },
  { id: "pude.builtin.toggleTerminal", title: "Terminal: Toggle Panel", source: "builtin", detail: "Show or hide the terminal" },
  { id: "pude.builtin.managePlugins", title: "Plugins: Manage Plugins", source: "builtin", detail: "View and enable installed plugins" },
];
