import { locale, type Locale } from "./i18n-runtime";

export type DocBlock =
  | { t: "h2" | "h3"; text: string }
  | { t: "p"; text: string }
  | { t: "code"; lang: string; code: string }
  | { t: "list"; items: string[] }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "note"; text: string }
  | { t: "release-status"; available: string; unavailable: string };

/** One documentation topic, shown in the docs editor as one Markdown file. */
export type DocSection = { id: string; file: string; nav: string; blocks: DocBlock[] };

type DocsDict = {
  docsPage: {
    title: string;
    sub: string;
    back: string;
    explorer: string;
    outline: string;
    source: string;
    preview: string;
    viewMode: string;
    versionLabel: string;
    stages: { preview: string; candidate: string; published: string };
    downloadLabel: string;
    sections: DocSection[];
  };
  footer: {
    tagline: string;
    built: string;
  };
};

const checksumCommands =
  "# macOS\nshasum -a 256 pude-macos-arm64.dmg\n\n# Windows (PowerShell)\nGet-FileHash .\\pude-windows-x64-setup.exe -Algorithm SHA256";

const pluginManifest = `{
  "id": "pude.example.document-case-toggle",
  "name": "Document Case Toggle",
  "version": "1.0.0",
  "apiVersion": "2",
  "entry": "extension.js",
  "permissions": ["editor.read", "editor.write", "commands.register", "ui.notification"],
  "activationEvents": ["onCommand:pude.example.document-case-toggle.toggleCase"],
  "contributes": {
    "commands": [
      { "command": "pude.example.document-case-toggle.toggleCase", "title": "Toggle Document Case" }
    ]
  }
}`;

const pluginEntry = `const commandId = "pude.example.document-case-toggle.toggleCase";

function toggleCase(text) {
  return text === text.toUpperCase() ? text.toLowerCase() : text.toUpperCase();
}

void pude.commands.register(commandId, async () => {
  const file = await pude.editor.getFileInfo();
  const text = await pude.editor.getText();

  if (text.length === 0) {
    await pude.ui.notify("The active document is empty.");
    return;
  }

  await pude.editor.applyEdits(file.revision, [
    { from: 0, to: text.length, insert: toggleCase(text) },
  ]);
  await pude.ui.notify("Document case toggled.");
});`;

const cloneCommands = "git clone https://github.com/MajajaX/pude.git\ncd pude\nnpm ci";
const checkCommands = "npm run check\ncargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml";

const en: DocsDict = {
  docsPage: {
    title: "Documentation",
    sub: "Install pude, learn the daily flow, and build your first plugin — read it the way you'd read it in pude.",
    back: "Back to site",
    explorer: "Explorer",
    outline: "Outline",
    source: "Source",
    preview: "Preview",
    viewMode: "Document view",
    versionLabel: "Version",
    stages: { preview: "Development preview", candidate: "Release candidate", published: "Published release" },
    downloadLabel: "Open download section",
    sections: [
      {
        id: "overview",
        file: "README.md",
        nav: "Overview",
        blocks: [
          { t: "h2", text: "Overview" },
          {
            t: "p",
            text: "pude is a local-first desktop code editor. It opens local folders as project tabs, edits text, shows Git, starts terminals on demand and loads local plugins — and keeps everything else out of the core.",
          },
          {
            t: "note",
            text: "These docs describe the pude 0.1 releases.",
          },
          { t: "h3", text: "What 0.1 includes" },
          {
            t: "list",
            items: [
              "Project tabs for several folders in one window, multi-folder workspaces saved as `.pdw` files, multiple windows, a lazy Explorer and on-demand project text/file search and replace",
              "Multi-tab editing, syntax highlighting, find and replace, Markdown preview",
              "Git status, commit graph, diffs and common actions through your system Git",
              "Multiple on-demand terminals backed by real PTYs, including opening at a file or folder from Explorer",
              "Local plugins with permission review (API 2) and a restricted LSP process manager",
            ],
          },
          { t: "h3", text: "What it leaves out on purpose" },
          {
            t: "list",
            items: [
              "Project-wide indexing, a debugger or a build system",
              "AI services, cloud sync and accounts",
              "A plugin marketplace, silent automatic updates and bundled language servers",
            ],
          },
          { t: "h3", text: "Reading these docs" },
          {
            t: "p",
            text: "Each file in the Explorer is one topic. Use `Source / Preview` in the status bar to see the Markdown behind any page, exactly as pude shows it.",
          },
        ],
      },
      {
        id: "releases",
        file: "install.md",
        nav: "Install & update",
        blocks: [
          { t: "h2", text: "Install and update" },
          {
            t: "table",
            head: ["Platform", "Installer"],
            rows: [
              ["Windows 11 x64", "`pude-windows-x64-setup.exe` (unsigned)"],
              ["macOS 14+ Apple Silicon", "`pude-macos-arm64.dmg` (signed and notarized)"],
              ["Linux", "Planned"],
            ],
          },
          {
            t: "release-status",
            available: "The home page recommends an installer for your OS. Confirm Windows 11 x64 or macOS 14+ Apple Silicon when your browser hides version or CPU details; both installers remain available to choose manually.",
            unavailable: "No verified release download is configured yet. Downloads stay disabled until a release is published and verified.",
          },
          { t: "h3", text: "Verify a download" },
          {
            t: "p",
            text: "Each release ships `SHA256SUMS.txt`, covering both installers, the update packages with their signatures, `latest.json` and the license files. Compare the checksum before you install:",
          },
          { t: "code", lang: "bash", code: checksumCommands },
          { t: "h3", text: "Updates" },
          {
            t: "p",
            text: "pude looks for a newer version on GitHub Releases about five seconds after startup, and again when you click `Check for updates` in `Help › About pude`. Turn the startup check off with `Check for updates on startup` in Settings. When a release is available, `Update [version]` appears beside the branch name at the lower left. Click it to download; the button shows `Downloading…`, then `Restart and update`. About keeps the same controls and release notes, and shows errors with a retry action. pude never downloads or installs an update by itself. The download is verified against its signature, and pude asks about unsaved changes before it restarts. You can also close pude, download the newer installer and run it.",
          },
          { t: "note", text: "Releases are published as stable versions only. Versions before 0.1.1 have no in-app updates; install a newer version by hand once." },
        ],
      },
      {
        id: "usage",
        file: "using-pude.md",
        nav: "Using pude",
        blocks: [
          { t: "h2", text: "Using pude" },
          { t: "h3", text: "Open a project" },
          {
            t: "p",
            text: "Choose `File › Open folder` (`⌘K ⌘O`, or `Ctrl+K Ctrl+O` on Windows) and pick a local directory. It opens as a project tab in the header; opening a folder that is already open switches to its tab. Only the top level is read, and folders load as you expand them. An empty tab lists `Recent folders` and `Recent workspaces` separately.",
          },
          {
            t: "list",
            items: [
              "Each project tab keeps its own files, unsaved edits, undo history, search, Git view and terminals while it is in the background. Drag project tabs to reorder them; they reopen in that order.",
              "`+` in the header adds an empty project tab. `File › New window` opens a separate window with its own projects.",
              "On Windows, right-click a folder and choose `Open with pude`.",
              "Right-click pude in the macOS Dock, or on the Windows taskbar or Start, for `New Window` and your recent folders and workspaces. A recent item opens as a new project tab in the pude window you used last, or switches to the tab that already shows it; only with no window open does it open a new one.",
            ],
          },
          { t: "h3", text: "Workspaces" },
          {
            t: "p",
            text: "A project tab can show several folders. Choose `File › Add folder to workspace…`, or the folder button with a split icon in the `FILES` bar. Explorer then shows a `(Workspace)` row with each folder below it, and search covers every folder. Right-click a folder row and choose `Remove Folder from Workspace` to take it out again.",
          },
          {
            t: "list",
            items: [
              "`File › Save workspace as…` saves the folders as a `.pdw` file. While the tab has a workspace file, adding or removing folders updates it. Folders near the file are stored as relative paths, so the workspace still opens after you move or clone the whole tree.",
              "`File › Open workspace…` opens a `.pdw` file in a new project tab, or switches to the tab that already shows it. Folders that no longer exist are skipped with a notice. From a terminal, `pude team.pdw` works too.",
              "Git, terminals and plugins use the first folder. If you remove the first folder, the next one takes over. `New file` and `New folder` in the `FILES` bar create items in the first folder; right-click another folder to create items there.",
            ],
          },
          { t: "h3", text: "Explorer" },
          {
            t: "list",
            items: [
              "Create, rename and delete files and folders. Deleting moves items to the Recycle Bin or Trash — never a permanent delete. The `FILES` bar under the sidebar tabs has `+` for a new file and a folder button for a new folder.",
              "Right-click a file or folder for `New file`, `New folder`, `Copy Name`, `Copy Path`, `Copy Relative Path`, `Open in Integrated Terminal` and `Reveal in Finder` (`Open in File Explorer` on Windows). On a file, `New file` and `New folder` create the item in that file's folder.",
              "Dot files are shown. Git-ignored items have gray names. The `Git ignored` root group uses a Git icon, divider and count; expand it to browse ignored items. Toggle `Group ignored` beside the footer’s plugin count to show them among normal entries instead. The choice is remembered after restart.",
              "Long folders stay fast: only visible rows are rendered.",
              "The chevron button in the `FILES` bar collapses every open subfolder. `⌘B` (`Ctrl+B`) hides or shows the whole sidebar for the current session.",
            ],
          },
          { t: "h3", text: "Project search" },
          { t: "p", text: "Select `SEARCH` beside `EXPLORER` and `GIT`, or press `⌘⇧F` (`Ctrl+Shift+F` on Windows); a short single-line selection in the editor becomes the query. `⌘P` (`Ctrl+P`) opens search in `Files` mode to go to a file by name. Choose `Text` for literal text or `Files` for names and relative paths; `Aa` matches case. Git-ignored files are excluded unless you enable `Include Git ignored files`. Results show the file name first, with its folder in a dimmer color and the line number beside it. Selecting a text result centers its match in the editor where scrolling allows, and highlights the matching text. Select `EXPLORER` or press Escape in the search input to return to files." },
          { t: "p", text: "To replace, select the chevron beside `Text / Files` to show `Replace with`. `Replace all` (or Enter in that field) replaces every match in the project, including files beyond the listed results; hover a result and select its replace button to change only that file. pude asks before it changes files and then reports how many matches and files changed." },
          { t: "note", text: "Replace uses the same literal text, `Aa` and Git-ignored rules as search. Files with unsaved edits are skipped and counted, open files without edits reload, and `Undo` cannot reverse a project-wide replacement. Replacing across files is available in the desktop app." },
          { t: "note", text: "Search reads saved files on demand, without an index; save your edits first. It skips `.git` and symlinks. Text search skips binary, unsupported, unreadable and over-2-MiB files. Each query is limited to 300 results, 50,000 entries, 100 MiB read and eight seconds. Narrow your query if a limit notice appears." },
          { t: "h3", text: "Edit" },
          {
            t: "list",
            items: [
              "File tabs support drag to reorder and middle-click close. Right-click a tab for `Pin`, `Save As…`, `Close others`, `Close to right`, `Close saved`, `Close all`, `Copy Path`, `Copy Relative Path` and `Reveal in Finder`. Closing a group of tabs keeps pinned tabs open. `⌘⇧T` (`Ctrl+Shift+T`) or the arrow at the end of the tab bar reopens closed tabs, most recent first; the last ten are remembered while pude runs.",
              "Find and replace with match case (`Aa`), regex (`.*`) and whole-word options; hover any find bar button to see what it does. The find bar shows which match is selected and how many there are (counting stops at 1,000 and is off in large-file mode). Enter finds the next match, Shift+Enter the previous one; in the replace field Enter replaces the next match and `⌘Enter` replaces all. Opening Find with a short selection searches for it.",
              "`⌘G` jumps to a line; type `line:column`, such as `12:5`, to land on a column. Clicking `Ln, Col` in the status bar does the same. The status bar also shows how many characters are selected, and `Spaces` or `Tab Size` for the indentation in use.",
              "Multiple cursors, undo and redo, and indentation come from CodeMirror 6. The editor highlights the current line, matching brackets and other copies of the selected text, closes brackets and quotes as you type, re-indents closing brackets, and folds blocks from the gutter. `⌘D` (`Ctrl+D`) adds the next match to the selection, `⌘⇧L` selects every match, and Alt-drag makes a column selection. Large-file mode leaves out folding and auto-closing.",
              "The command palette (`⌘⇧P`) shows each command's shortcut, matches words in any order and lists the commands you ran recently first. It includes editing commands such as `Sort Lines Ascending`, `Transform to Uppercase`, `Trim Trailing Whitespace`, `Fold All`, `Toggle Line Comment` and `Duplicate Line`, and view commands such as `Toggle Word Wrap` (`⌥Z`, `Alt+Z`), `Toggle Line Numbers` and `Toggle Whitespace`.",
              "`.env` and `.env.*` files have shell syntax highlighting for assignments, quoted strings, numbers, expansions and comments, and show `Dotenv` in the status bar. The same large-file limits apply.",
              "`.env` files open as a table: each variable has a name field and a value field, each with a copy button, and `Line` copies the whole `NAME=value` line. Add, rename, edit or delete variables there; only the changed text is rewritten, and a value is quoted when it needs to be. The `Source / Table` button in the lower-right corner switches views, and every `.env` file in the project follows that choice. The table is off for files over 512 KiB.",
              "Hold `⌘` (or `Ctrl`) and scroll over the editor, or press `⌘=` / `⌘-` (`Ctrl+=` / `Ctrl+-`), to set the font size between 11 and 24; `⌘0` (`Ctrl+0`) returns to 14.",
              "The interface uses the open-source Inter typeface; the editor, terminals and diffs use JetBrains Mono. Both are bundled with pude, so they look the same offline and on every platform. Chinese text falls back to the system font.",
              "Markdown opens as source. The `Source / Preview` button in the lower-right corner of the editor switches to a rendered preview, and every Markdown file in the project follows that choice. Preview uses the available editor width with smaller side margins and clear body text in both themes.",
            ],
          },
          { t: "h3", text: "Files pude opens" },
          {
            t: "list",
            items: [
              "UTF-8 and UTF-8 with BOM. Invalid UTF-8 and other encodings are refused rather than silently converted.",
              "Files over 5 MiB open in large-file mode: editing and search stay on, heavy parsing and preview turn off.",
              "Text files are limited to 20 MiB. Supported images open in an image preview.",
            ],
          },
          { t: "h3", text: "Saving safely" },
          {
            t: "p",
            text: "Saves are queued per file and replace it atomically. Every line keeps its original LF or CRLF ending. If a file changes on disk while you have unsaved edits, pude offers `Compare`, `Reload from disk`, `Save As…` or `Keep editor version` — it never overwrites either side silently.",
          },
          {
            t: "p",
            text: "Unsaved work is checkpointed locally for recovery. Recovery restores the last completed checkpoint, not every keystroke.",
          },
        ],
      },
      {
        id: "git",
        file: "git.md",
        nav: "Git",
        blocks: [
          { t: "h2", text: "Git" },
          {
            t: "p",
            text: "pude uses the Git installed on your system, so `git` must be on your `PATH`. Without Git, editing keeps working and the Git panel says it is unavailable.",
          },
          { t: "h3", text: "Status and history" },
          {
            t: "list",
            items: [
              "Switch the sidebar to `GIT` for the branch plus staged, unstaged, untracked, renamed and conflicted files. The current branch sits at the top, and each changed file shows its name first with its folder in a dimmer color.",
              "The commit graph handles detached HEAD, unborn branches and multiple refs. Older commits load automatically as you scroll near the end, and the history refreshes after commits, push, pull, branch and stash operations, including ones run outside pude. Open the full history as an editor tab, filter it by branch, and select a commit to see its changed files.",
              "When the repository has stashes, a `STASH` tab appears beside `STATUS` and `HISTORY`. Expand a stash to see its changed files and open their diffs. `Apply` keeps the stash, `Pop` applies and removes it, and the trash button drops it; each asks first.",
              "Open any change as a `Side by side` or `Stacked` diff.",
            ],
          },
          { t: "h3", text: "Actions" },
          {
            t: "p",
            text: "The action groups `Changes`, `Sync`, `Branches` and `Stash` are always shown in the Git view. Stage and unstage, discard changes, commit (or stage all and commit), push and pull, create, switch or safely delete branches, create a worktree, stash and pop. Risky actions ask for confirmation first. When a command fails, the full Git output opens in a dialog instead of a toast that disappears.",
          },
          {
            t: "note",
            text: "The panel refreshes from events — saves, file changes and Git actions — never from background polling. Full rebase and merge-resolution interfaces are not included yet.",
          },
        ],
      },
      {
        id: "terminal",
        file: "terminal.md",
        nav: "Terminal",
        blocks: [
          { t: "h2", text: "Terminal" },
          {
            t: "p",
            text: "Toggle the panel with `` ⌘` `` (`` Ctrl+` `` on Windows) and add as many tabs as you need. Each tab loads xterm.js and starts its own PTY the first time it is shown.",
          },
          {
            t: "list",
            items: [
              "Right-click a folder in Explorer and choose `Open in Integrated Terminal` to create a new tab in that directory. For a file, it starts in the file’s parent directory. Existing terminal tabs keep their current directories.",
              "Every project has its own terminals. Hiding the panel or switching to another project keeps them running; closing a terminal tab, the project or the window stops that terminal's process tree.",
              "Drag the top edge of the terminal panel to resize it, or focus the edge and press the Up/Down arrow keys. The height is saved and used for every project; the editor always keeps at least 120 px.",
              "Windows starts PowerShell 7 (`pwsh.exe`) when it is on `PATH`, otherwise Windows PowerShell, like Windows Terminal. macOS and Linux start `SHELL` as a login shell, falling back to `/bin/sh`, so the terminal sees the same `PATH` as your usual terminal app.",
              "`Ctrl+C` interrupts the running program, such as a dev server, and returns you to the same prompt, as in your operating system's terminal. If a shell ends, the tab shows its exit status and a `Restart terminal` button; pude does not start a new shell by itself.",
              "A Python virtual environment in `.venv`, `venv` or `env` is not activated automatically, because a cloned repository could otherwise put its own executables first on `PATH`. The terminal prints `Python environment found: <name> (not activated)` and a hint. Run `Terminal: Trust Python Environment` from the command palette to activate it for that project folder from then on (the terminal restarts); `Terminal: Stop Trusting Python Environment` reverts it. The choice is remembered per project folder on this machine.",
              "Scrollback keeps 5,000 lines. ANSI colors, the alternate screen, mouse tracking, CJK text and IME input work as expected.",
            ],
          },
          {
            t: "note",
            text: "Terminals run with your user's permissions. They are not a sandbox: commands can reach files outside the workspace and the network.",
          },
        ],
      },
      {
        id: "settings",
        file: "settings.md",
        nav: "Settings & data",
        blocks: [
          { t: "h2", text: "Settings and local data" },
          {
            t: "table",
            head: ["Setting", "What it does"],
            rows: [
              ["Language", "`System default` (default), `English` or `繁體中文`. System default picks Traditional Chinese when your system prefers it. Applies right away; Git, terminal and plugin messages keep their own language."],
              ["Theme", "`Dark` (default) or `Light`. The sun and moon button in the header switches it too."],
              ["Font size", "Editor text size from 11 to 24, applied when you leave the field. `⌘` + scroll and `⌘=` / `⌘-` change it too."],
              ["Tab size", "Width used for tabs and indentation, from 1 to 8."],
              ["Indent with spaces", "Indents with spaces; turn it off to indent with tab characters. On by default."],
              ["Word wrap", "Wraps long lines inside the editor. `⌥Z` (`Alt+Z`) toggles it."],
              ["Line numbers", "Shows the line number and fold gutter. On by default."],
              ["Show whitespace", "Marks spaces, tabs and trailing whitespace. Off by default."],
              ["Close brackets and quotes automatically", "Types the closing `)`, `]`, `}` or quote for you. On by default."],
              ["Trim trailing whitespace on save", "Removes spaces and tabs at line ends when you save the file shown in the editor. Off by default."],
              ["End files with a newline on save", "Adds a final newline when you save the file shown in the editor. Off by default."],
              ["Hide dot files", "Hides names starting with `.` in the Explorer. Off by default."],
              ["Group Git ignored files", "Groups Git-ignored root items; also in the Explorer footer as `Group ignored`. On by default; remembered locally. Independent of project search’s include-ignored filter."],
              ["Check for updates on startup", "Looks for a newer release shortly after startup. On by default."],
              ["Watcher excluded paths", "Paths the file watcher ignores, such as build output."],
            ],
          },
          { t: "p", text: "Open Settings from `View › Settings` or with `⌘,` (`Ctrl+,`). Settings are grouped into Interface, Editor, Saving, Explorer and Updates. `Restore defaults` at the bottom asks for a second click, then resets everything except the language." },
          { t: "h3", text: "Where your data lives" },
          {
            t: "list",
            items: [
              "Workspace files stay at their own paths. pude never copies them elsewhere.",
              "Settings, recent folders and workspaces, and session metadata are kept in local WebView storage. `.pdw` workspace files are saved where you choose.",
              "Recovery checkpoints use IndexedDB with a local fallback. Clearing app storage can remove them.",
              "Installed plugins are copied into the app data directory.",
              "Error diagnostics go to a small rolling log in the app's log directory, with common credentials redacted. Nothing is sent anywhere.",
            ],
          },
        ],
      },
      {
        id: "shortcuts",
        file: "shortcuts.md",
        nav: "Shortcuts",
        blocks: [
          { t: "h2", text: "Keyboard shortcuts" },
          {
            t: "table",
            head: ["Action", "macOS", "Windows"],
            rows: [
              ["Save", "`⌘S`", "`Ctrl+S`"],
              ["Save as", "`⌘⇧S`", "`Ctrl+Shift+S`"],
              ["Save all", "`⌘⌥S`", "`Ctrl+Alt+S`"],
              ["Open file", "`⌘O`", "`Ctrl+O`"],
              ["Open folder", "`⌘K ⌘O`", "`Ctrl+K Ctrl+O`"],
              ["Close tab", "`⌘W`", "`Ctrl+W`"],
              ["Reopen closed tab", "`⌘⇧T`", "`Ctrl+Shift+T`"],
              ["Next / previous tab", "`⌃⇥` / `⌃⇧⇥`", "`Ctrl+Tab` / `Ctrl+Shift+Tab`"],
              ["Find", "`⌘F`", "`Ctrl+F`"],
              ["Find next / previous", "`Enter` / `⇧Enter`", "`Enter` / `Shift+Enter`"],
              ["Search project text", "`⌘⇧F`", "`Ctrl+Shift+F`"],
              ["Go to file", "`⌘P`", "`Ctrl+P`"],
              ["Replace", "`⌘⌥F`", "`Ctrl+H`"],
              ["Go to line", "`⌘G`", "`Ctrl+G`"],
              ["Add next match / select all matches", "`⌘D` / `⌘⇧L`", "`Ctrl+D` / `Ctrl+Shift+L`"],
              ["Toggle line comment", "`⌘/`", "`Ctrl+/`"],
              ["Fold / unfold block", "`⌘⌥[` / `⌘⌥]`", "`Ctrl+Shift+[` / `Ctrl+Shift+]`"],
              ["Command palette", "`⌘⇧P`", "`Ctrl+Shift+P`"],
              ["Settings", "`⌘,`", "`Ctrl+,`"],
              ["Toggle sidebar", "`⌘B`", "`Ctrl+B`"],
              ["Toggle word wrap", "`⌥Z`", "`Alt+Z`"],
              ["Markdown source / preview", "`⌘⇧V`", "`Ctrl+Shift+V`"],
              ["Toggle terminal", "`` ⌘` ``", "`` Ctrl+` ``"],
              ["Font size", "`⌘=` / `⌘-` / `⌘0`, or `⌘` + scroll", "`Ctrl+=` / `Ctrl+-` / `Ctrl+0`, or `Ctrl` + scroll"],
            ],
          },
          { t: "note", text: "Custom key bindings are planned." },
        ],
      },
      {
        id: "plugins",
        file: "plugins.md",
        nav: "Plugins",
        blocks: [
          { t: "h2", text: "Building a plugin" },
          {
            t: "p",
            text: "A plugin is a local folder with a `plugin.json` manifest and a JavaScript entry. It runs in a Web Worker inside an opaque-origin sandbox and reaches pude only through the asynchronous `pude` API — no DOM, CodeMirror, Tauri or browser storage.",
          },
          {
            t: "note",
            text: "Plugins are executable code you choose to trust. Permissions are deny-by-default and reviewed before install, but the sandbox is not a complete OS security boundary. Install only plugins whose source you trust.",
          },
          { t: "h3", text: "1. Write the manifest" },
          {
            t: "p",
            text: "This is the runnable example from `examples/plugins/document-case-toggle`. Every contributed command needs a matching `onCommand:<id>` event; `onLanguage:<id>`, `onFileOpen`, `onFileSave` and `onWorkspaceOpen` are also available.",
          },
          { t: "code", lang: "json", code: pluginManifest },
          { t: "h3", text: "2. Write the entry" },
          { t: "code", lang: "js", code: pluginEntry },
          { t: "h3", text: "3. Install and iterate" },
          {
            t: "list",
            items: [
              "Open `Plugins`, choose `Install local plugin` and select the folder.",
              "Review the requested permissions and approve only what the plugin needs. `Cancel` keeps the current version and grants.",
              "Enable the plugin and run its command from the command palette.",
              "After editing, use `Update from folder`. The new version replaces the old one only after you approve it.",
            ],
          },
          { t: "h3", text: "API at a glance" },
          {
            t: "table",
            head: ["Permission", "Calls", "Notes"],
            rows: [
              ["`editor.read`", "`getText`, `getTextRange`, `getSelection`, `getCursor`, `getFileInfo`", "Up to 128 Ki code units per call"],
              ["`editor.write`", "`applyEdits(revision, edits)`", "Up to 1,000 edits; normal undo and dirty state"],
              ["`workspace.read`", "`list`, `readFile`, `getFileInfo`, `readFileRange`", "128 KiB per read; ranges for larger files"],
              ["`workspace.write`", "`writeFile`", "Conflict-checked; never deletes"],
              ["`commands.register`", "`commands.register`", "Declared commands only"],
              ["`ui.*`", "`ui.notify`, `ui.statusBar`, `ui.quickPick`", "Rendered by pude, bounded text"],
              ["`git.read`", "`git.getStatus`, `git.getDiff`", "Read only"],
              ["`terminal.write`", "`terminal.write`", "Only terminals the user opened"],
              ["`network`", "`network.fetch`", "HTTPS to approved domains"],
              ["`process.spawn:lsp`", "`lsp.start`, `send`, `cancel`, `stop`", "Declared servers only"],
            ],
          },
          {
            t: "p",
            text: "Each run allows 512 concurrent requests, 20 requests per second, a 30-second timeout, 64 KiB requests and 1 MiB responses. The full reference lives in `docs/plugin-api-v2.md`.",
          },
        ],
      },
      {
        id: "installation",
        file: "build.md",
        nav: "Build from source",
        blocks: [
          { t: "h2", text: "Build from source" },
          {
            t: "list",
            items: [
              "Node.js `22.12+`, `24+` or `26+` with npm `10.9+` (Node.js 24 recommended)",
              "Rust stable through `rustup`, and Git on `PATH`",
              "macOS: Xcode Command Line Tools · Windows: MSVC C++ build tools and WebView2 · Linux: the Tauri GTK/WebKit packages",
            ],
          },
          { t: "code", lang: "bash", code: cloneCommands },
          { t: "h3", text: "Commands" },
          {
            t: "table",
            head: ["Command", "Purpose"],
            rows: [
              ["`npm run tauri:dev`", "Run the native desktop app"],
              ["`npm run dev`", "Desktop UI in a browser shell (port 5173)"],
              ["`npm run web:dev`", "This website (port 5174)"],
              ["`npm test`", "Desktop Vitest suite"],
              ["`npm run tauri:build`", "Native bundles for the current platform"],
            ],
          },
          {
            t: "note",
            text: "The browser shell uses an in-memory demo workspace. It does not exercise native files, Git, terminals or plugin installation.",
          },
          { t: "h3", text: "Before a pull request" },
          { t: "p", text: "Include documentation with every feature or behavior change: update `docs/product-spec.md`, `CHANGELOG.md`, the README and both website languages where affected. Cover shortcuts, settings, limits, permissions and platform differences; review screenshots and SEO metadata. Explain unaffected surfaces in the PR and preserve historical benchmark versions and dates." },
          { t: "code", lang: "bash", code: checkCommands },
        ],
      },
    ] satisfies DocSection[],
  },
  footer: {
    tagline: "pude — pure code editor",
    built: "Built with Tauri, SolidJS, CodeMirror 6 and Rust. MIT licensed.",
  },
};

const zhHant: DocsDict = {
  docsPage: {
    title: "使用文件",
    sub: "安裝 pude、熟悉日常流程，再動手寫第一個外掛——就像在 pude 裡閱讀一樣。",
    back: "返回首頁",
    explorer: "檔案",
    outline: "大綱",
    source: "原始碼",
    preview: "預覽",
    viewMode: "文件檢視方式",
    versionLabel: "版本",
    stages: { preview: "開發預覽版", candidate: "正式版候選", published: "已發布版本" },
    downloadLabel: "開啟首頁下載區",
    sections: [
      {
        id: "overview",
        file: "README.md",
        nav: "總覽",
        blocks: [
          { t: "h2", text: "總覽" },
          {
            t: "p",
            text: "pude 是本地優先的桌面程式碼編輯器。它把本機資料夾開成專案分頁、編輯文字、呈現 Git、按需啟動終端機並載入本機外掛——其餘的一律不放進核心。",
          },
          {
            t: "note",
            text: "本文件描述 pude 0.1 系列版本。",
          },
          { t: "h3", text: "0.1 包含什麼" },
          {
            t: "list",
            items: [
              "在同一個視窗以專案分頁開啟多個資料夾、可存成 `.pdw` 檔的多資料夾工作區、多視窗、按需載入的檔案總管與專案文字／檔案搜尋及取代",
              "多分頁編輯、語法突顯、尋找與取代、Markdown 預覽",
              "透過系統 Git 呈現狀態、提交圖譜、差異與常用操作",
              "以真實 PTY 運作、按需啟動的多個終端機，可從檔案總管在指定檔案或資料夾所在目錄開啟",
              "具權限審核的本機外掛（API 2）與受控 LSP 程序管理器",
            ],
          },
          { t: "h3", text: "刻意不做什麼" },
          {
            t: "list",
            items: [
              "全專案索引、除錯器或建置系統",
              "AI 服務、雲端同步與帳號",
              "外掛市集、靜默自動更新與內附語言伺服器",
            ],
          },
          { t: "h3", text: "如何閱讀本文件" },
          {
            t: "p",
            text: "檔案總管裡的每個檔案就是一個主題。用狀態列的 `Source / Preview` 切換，就能看到每一頁背後的 Markdown，與 pude 顯示的完全相同。",
          },
        ],
      },
      {
        id: "releases",
        file: "install.md",
        nav: "安裝與更新",
        blocks: [
          { t: "h2", text: "安裝與更新" },
          {
            t: "table",
            head: ["平台", "安裝檔"],
            rows: [
              ["Windows 11 x64", "`pude-windows-x64-setup.exe`（未簽署）"],
              ["macOS 14+ Apple Silicon", "`pude-macos-arm64.dmg`（已簽署並公證）"],
              ["Linux", "規劃中"],
            ],
          },
          {
            t: "release-status",
            available: "首頁下載區會依作業系統推薦安裝檔。瀏覽器隱藏版本或處理器資訊時，請確認為 Windows 11 x64 或 macOS 14 以上 Apple Silicon；也能手動選擇兩種安裝檔。",
            unavailable: "尚未設定經核實的版本下載入口；正式版本發布並通過驗證前，下載入口會保持停用。",
          },
          { t: "h3", text: "驗證下載檔" },
          {
            t: "p",
            text: "每個版本都附有 `SHA256SUMS.txt`，涵蓋兩個安裝檔、更新套件與其簽章、`latest.json` 以及授權文件。安裝前請先比對雜湊值：",
          },
          { t: "code", lang: "bash", code: checksumCommands },
          { t: "h3", text: "更新" },
          {
            t: "p",
            text: "pude 會在啟動後約五秒，以及你在 `Help › About pude` 按下 `Check for updates` 時，到 GitHub Releases 查詢新版本。可在設定中關閉 `Check for updates on startup`。有新版本時，視窗左下角分支名稱右邊會出現 `Update [版本]` 按鈕。點擊即可下載，按鈕會依序顯示 `Downloading…` 與 `Restart and update`；About 仍保留更新控制與版本說明，失敗時會顯示錯誤與重試操作。pude 不會自行下載或安裝更新。下載的更新會先驗證簽章，重新啟動前也會詢問如何處理未儲存的變更。你也可以關閉 pude，下載較新的安裝檔並執行。",
          },
          { t: "note", text: "發布的版本一律為穩定版。0.1.1 之前的版本沒有內建更新，需要手動安裝一次新版本。" },
        ],
      },
      {
        id: "usage",
        file: "using-pude.md",
        nav: "使用教學",
        blocks: [
          { t: "h2", text: "使用教學" },
          { t: "h3", text: "開啟專案" },
          {
            t: "p",
            text: "選擇 `File › Open folder`（`⌘K ⌘O`，Windows 為 `Ctrl+K Ctrl+O`）並挑選本機資料夾，它會在標題列開成一個專案分頁；開啟已經開著的資料夾則會切換到該分頁。pude 只讀取最上層，展開時才載入子資料夾。空白分頁會分開列出 `Recent folders`（最近的資料夾）與 `Recent workspaces`（最近的工作區）。",
          },
          {
            t: "list",
            items: [
              "每個專案分頁在背景時都保留自己的檔案、未儲存的修改、復原紀錄、搜尋、Git 檢視與終端機。專案分頁可以拖曳排序，下次會依相同順序開啟。",
              "標題列的 `+` 會新增空白專案分頁；`File › New window` 會開啟另一個擁有自己專案的視窗。",
              "在 Windows 上，可以對資料夾按右鍵選擇 `Open with pude`。",
              "在 macOS 的 Dock，或 Windows 的工作列與開始功能表對 pude 按右鍵，可選 `New Window` 以及最近的資料夾和工作區。選擇最近項目會在你最後使用的 pude 視窗開成新的專案分頁，若已經開著則切換到該分頁；只有沒有任何視窗時才會開新視窗。",
            ],
          },
          { t: "h3", text: "工作區" },
          {
            t: "p",
            text: "一個專案分頁可以同時顯示多個資料夾。選擇 `File › Add folder to workspace…`，或 `FILES` 列上帶分割圖示的按鈕即可加入。檔案總管會顯示一列 `(Workspace)`，底下是各個資料夾，專案搜尋也會涵蓋所有資料夾。對資料夾列按右鍵選擇 `Remove Folder from Workspace` 可以移除。",
          },
          {
            t: "list",
            items: [
              "`File › Save workspace as…` 會把這些資料夾存成 `.pdw` 檔。分頁有工作區檔案時，加入或移除資料夾都會自動更新它。與檔案位置相近的資料夾以相對路徑儲存，整個目錄搬移或重新 clone 後仍可開啟。",
              "`File › Open workspace…` 會以新的專案分頁開啟 `.pdw` 檔，若已經開著則切換到該分頁。不存在的資料夾會略過並提示。也可以在終端機執行 `pude team.pdw`。",
              "Git、終端機與外掛使用第一個資料夾；移除第一個資料夾時，由下一個資料夾接手。`FILES` 列的 `New file` 與 `New folder` 會建立在第一個資料夾，要在其他資料夾建立項目請對該資料夾按右鍵。",
            ],
          },
          { t: "h3", text: "檔案總管" },
          {
            t: "list",
            items: [
              "建立、重新命名與刪除檔案和資料夾。刪除會移到資源回收筒或垃圾桶，絕不永久刪除。側邊欄分頁下方的 `FILES` 列有 `+`（新增檔案）與資料夾按鈕（新增資料夾）。",
              "對檔案或資料夾按右鍵，可使用 `New file`、`New folder`、`Copy Name`、`Copy Path`、`Copy Relative Path`、`Open in Integrated Terminal` 與 `Reveal in Finder`（Windows 為 `Open in File Explorer`）。在檔案上按右鍵時，`New file` 與 `New folder` 會建立在該檔案所在的資料夾。",
              "會顯示以 `.` 開頭的檔案。被 Git 忽略的項目以灰色顯示；根目錄的 `Git ignored` 群組以 Git 圖示、分隔線與數量標示，展開即可瀏覽。在底部外掛數量旁取消勾選 `Group ignored`，可將項目放回一般列表；重新啟動後也會記住選擇。",
              "很長的資料夾也保持流暢：只渲染看得到的列。",
              "`FILES` 列上的箭頭按鈕會收合所有展開的子資料夾。`⌘B`（`Ctrl+B`）可在本次執行期間隱藏或顯示整個側邊欄。",
            ],
          },
          { t: "h3", text: "專案搜尋" },
          { t: "p", text: "選擇 `EXPLORER / GIT / SEARCH` 中的 `SEARCH` 分頁，或按 `⌘⇧F`（Windows 為 `Ctrl+Shift+F`）；若編輯器中選取了一小段單行文字，會直接作為搜尋內容。`⌘P`（`Ctrl+P`）會以 `Files` 模式開啟搜尋，依名稱跳至檔案。`Text` 搜尋文字，`Files` 搜尋檔名與相對路徑，`Aa` 切換區分大小寫。預設排除 Git 忽略的檔案，勾選 `Include Git ignored files` 可納入。結果先顯示檔名，所在資料夾以較淡的顏色列在旁邊，並附上行號。選取文字結果會開啟檔案，在可捲動的範圍內將命中處置中，並反白標示文字；選擇 `EXPLORER` 或在搜尋欄按 Escape 可回到檔案列表。" },
          { t: "p", text: "要取代時，按 `Text / Files` 旁的箭頭顯示 `Replace with`。`Replace all`（或在該欄按 Enter）會取代整個專案的所有符合項目，包括清單以外的檔案；將滑鼠移到某筆結果上按取代按鈕，則只取代那個檔案。pude 會先請你確認，完成後告訴你取代了幾處、幾個檔案。" },
          { t: "note", text: "取代沿用搜尋的純文字比對、`Aa` 與 Git 忽略規則。有未儲存修改的檔案會略過並計數，沒有修改的已開啟檔案會重新載入；全專案取代無法用 `Undo` 復原。跨檔案取代僅在桌面版提供。" },
          { t: "note", text: "搜尋按需讀取已儲存的檔案，不建立索引；請先儲存修改。它不搜尋 `.git`，也不跟隨符號連結。文字搜尋略過二進位、不支援、無法讀取及超過 2 MiB 的檔案。每次最多 300 筆結果、50,000 個項目、讀取 100 MiB 或執行八秒；出現限制提示時請縮小搜尋範圍。" },
          { t: "h3", text: "編輯" },
          {
            t: "list",
            items: [
              "檔案分頁支援拖曳排序與中鍵關閉。在分頁上按右鍵可使用 `Pin`、`Save As…`、`Close others`、`Close to right`、`Close saved`、`Close all`、`Copy Path`、`Copy Relative Path` 與 `Reveal in Finder`。一次關閉多個分頁時會保留已釘選的分頁。`⌘⇧T`（`Ctrl+Shift+T`）或分頁列最右側的箭頭可依最近順序重新開啟關閉的分頁，pude 執行期間會記住最近十個。",
              "尋找與取代支援區分大小寫（`Aa`）、正規表示式（`.*`）與全字比對；將滑鼠移到尋找列的按鈕上即可看到說明。尋找列會顯示目前是第幾個符合項目與總數（最多計算 1,000 個，大型檔案模式不計算）。Enter 尋找下一個，Shift+Enter 尋找上一個；在取代欄按 Enter 取代下一個，`⌘Enter` 全部取代。選取一小段文字後開啟尋找，會直接搜尋它。",
              "`⌘G` 跳至指定行；輸入 `行:欄`（例如 `12:5`）可直接跳到該欄。點狀態列的 `Ln, Col` 也能開啟。狀態列也會顯示已選取的字元數，並依目前的縮排方式顯示 `Spaces` 或 `Tab Size`。",
              "多游標、復原與重做、縮排由 CodeMirror 6 提供。編輯器會標示目前所在行、對應的括號以及與選取內容相同的文字，輸入時自動補上右括號與引號，輸入右括號時自動調整縮排，並可從行號欄摺疊區塊。`⌘D`（`Ctrl+D`）將下一個相符項目加入選取，`⌘⇧L` 選取所有相符項目，按住 Alt 拖曳可進行欄選取。大型檔案模式不提供摺疊與自動補括號。",
              "命令面板（`⌘⇧P`）會顯示每個指令的快捷鍵，關鍵字可不分順序比對，最近執行過的指令排在最前面。面板中包含 `Sort Lines Ascending`、`Transform to Uppercase`、`Trim Trailing Whitespace`、`Fold All`、`Toggle Line Comment`、`Duplicate Line` 等編輯指令，以及 `Toggle Word Wrap`（`⌥Z`、`Alt+Z`）、`Toggle Line Numbers`、`Toggle Whitespace` 等檢視指令。",
              "`.env` 與 `.env.*` 支援 shell 語法高亮，包括變數賦值、引號、數字、變數展開與註解，狀態列顯示 `Dotenv`；沿用相同的大型檔案限制。",
              "`.env` 檔會以表格開啟：每個變數都有名稱與值兩個輸入框，各自附有複製按鈕，`整行` 則複製整行 `NAME=value`。可以在表格中新增、改名、修改或刪除變數；只會改寫變動的文字，值需要時會自動加上引號。編輯器右下角的 `原始碼 / 表格` 按鈕可切換檢視，同一個專案裡的 `.env` 檔都會沿用這個選擇。超過 512 KiB 的檔案不提供表格檢視。",
              "按住 `⌘`（或 `Ctrl`）在編輯器上捲動滾輪，或按 `⌘=` / `⌘-`（`Ctrl+=` / `Ctrl+-`），可將字體大小調整為 11 到 24；`⌘0`（`Ctrl+0`）還原為 14。",
              "介面使用開源字型 Inter，編輯器、終端機與差異檢視使用 JetBrains Mono。兩者都隨 pude 內建，離線與各平台顯示一致；中文會使用系統字型。",
              "Markdown 預設顯示原始碼；編輯器右下角的 `Source / Preview` 按鈕可切換為渲染預覽，同一個專案裡的 Markdown 檔都會沿用這個選擇。預覽會使用編輯區可用寬度，縮小兩側留白，並在深淺主題使用清晰的內文字色。",
            ],
          },
          { t: "h3", text: "可開啟的檔案" },
          {
            t: "list",
            items: [
              "UTF-8 與含 BOM 的 UTF-8。無效的 UTF-8 或其他編碼會被拒絕，不會默默轉碼。",
              "超過 5 MiB 的檔案以大型檔案模式開啟：保留編輯與搜尋，關閉重型解析與預覽。",
              "文字檔上限為 20 MiB；支援的圖片會以圖片預覽開啟。",
            ],
          },
          { t: "h3", text: "安全地儲存" },
          {
            t: "p",
            text: "每個檔案的儲存會依序排隊，並以原子化方式取代原檔。每一行都保留原本的 LF 或 CRLF。若檔案在你尚未儲存時被外部修改，pude 會提供 `Compare`、`Reload from disk`、`Save As…` 或 `Keep editor version`——絕不默默覆寫任何一方。",
          },
          {
            t: "p",
            text: "未儲存的內容會在本機建立復原檢查點。復原會還原最後一次完成的檢查點，而不是每一次按鍵。",
          },
        ],
      },
      {
        id: "git",
        file: "git.md",
        nav: "Git",
        blocks: [
          { t: "h2", text: "Git" },
          {
            t: "p",
            text: "pude 使用你系統上安裝的 Git，因此 `git` 必須在 `PATH` 中。沒有 Git 時仍可正常編輯，Git 面板會顯示無法使用。",
          },
          { t: "h3", text: "狀態與歷史" },
          {
            t: "list",
            items: [
              "把側邊欄切到 `GIT`，即可看到分支，以及已暫存、未暫存、未追蹤、已重新命名與衝突的檔案。目前分支顯示在最上方，每個變更檔案先顯示檔名，所在資料夾以較淡的顏色列在旁邊。",
              "提交圖譜能處理 detached HEAD、尚無提交的分支與多個 refs。捲動到接近底部時會自動載入更早的提交；提交、推送、拉取、分支與 stash 操作後（包括在 pude 以外執行的操作）歷史會自動更新。完整歷史可以開成編輯器分頁、依分支篩選，選取提交即可查看變更的檔案。",
              "儲存庫有 stash 時，`STATUS` 與 `HISTORY` 旁會出現 `STASH` 分頁。展開 stash 可查看變更的檔案並開啟差異。`Apply` 套用並保留 stash，`Pop` 套用後移除，垃圾桶按鈕則直接刪除；每項操作都會先請你確認。",
              "任何變更都能以 `Side by side`（並排）或 `Stacked`（堆疊）方式檢視差異。",
            ],
          },
          { t: "h3", text: "操作" },
          {
            t: "p",
            text: "Git 檢視會一直顯示 `Changes`、`Sync`、`Branches` 與 `Stash` 操作群組。暫存與取消暫存、捨棄變更、提交（或全部暫存並提交）、推送與拉取、建立／切換／安全刪除分支、建立 worktree、stash 與 pop。有風險的操作會先請你確認。指令失敗時，完整的 Git 輸出會顯示在對話框中，而不是一閃即逝的提示。",
          },
          {
            t: "note",
            text: "面板由事件觸發更新——儲存、檔案變更與 Git 操作——從不在背景輪詢。目前尚未提供完整的 rebase 與合併衝突解決介面。",
          },
        ],
      },
      {
        id: "terminal",
        file: "terminal.md",
        nav: "終端機",
        blocks: [
          { t: "h2", text: "終端機" },
          {
            t: "p",
            text: "用 `` ⌘` ``（Windows 為 `` Ctrl+` ``）切換面板，需要幾個分頁就開幾個。每個分頁第一次顯示時，才會載入 xterm.js 並啟動自己的 PTY。",
          },
          {
            t: "list",
            items: [
              "在檔案總管對資料夾按右鍵，選擇 `Open in Integrated Terminal`，會在該目錄建立新的終端機分頁；對檔案使用時則開在檔案所在的資料夾。既有終端機分頁的目錄不會改變。",
              "每個專案都有自己的終端機。隱藏面板或切換到其他專案時仍會繼續執行；關閉終端機分頁、關閉專案或關閉視窗，才會停止該終端機的程序樹。",
              "拖曳終端機面板的上緣即可調整高度，也可以聚焦上緣後按上／下方向鍵調整。高度會被記住並套用到所有專案，編輯器至少保留 120 px。",
              "Windows 優先啟動 PowerShell 7（`pwsh.exe`，需在 `PATH` 中），否則使用 Windows PowerShell，與 Windows Terminal 一致；macOS 與 Linux 以登入 shell 啟動 `SHELL`，未設定時改用 `/bin/sh`，因此終端機看到的 `PATH` 與你平常用的終端機相同。",
              "按 `Ctrl+C` 會中斷正在執行的程式（例如 dev server），並回到同一個提示字元，行為與作業系統的終端機相同。若 shell 結束，分頁會顯示結束狀態與 `Restart terminal` 按鈕，pude 不會自行啟動新的 shell。",
              "`.venv`、`venv` 或 `env` 中的 Python 虛擬環境不會自動啟用，因為複製來的程式庫可能把自己的執行檔放到 `PATH` 最前面。終端機會顯示 `Python environment found: <name> (not activated)` 與提示。從命令面板執行 `Terminal: Trust Python Environment`，之後該專案資料夾就會啟用它（終端機會重新啟動）；`Terminal: Stop Trusting Python Environment` 可還原。這項選擇會依專案資料夾記在這台電腦上。",
              "scrollback 保留 5,000 行，支援 ANSI 色彩、alternate screen、滑鼠追蹤、中日韓文字與輸入法。",
            ],
          },
          {
            t: "note",
            text: "終端機以你的使用者權限執行，並不是沙箱：指令可以存取工作區外的檔案，也可以連網。",
          },
        ],
      },
      {
        id: "settings",
        file: "settings.md",
        nav: "設定與資料",
        blocks: [
          { t: "h2", text: "設定與本機資料" },
          {
            t: "table",
            head: ["設定", "作用"],
            rows: [
              ["語言（Language）", "`跟隨系統`（預設）、`English` 或 `繁體中文`。跟隨系統時，若系統偏好語言為繁體中文就使用繁體中文。切換後立即生效；Git、終端機與外掛的訊息維持原本的語言。"],
              ["Theme", "`Dark`（預設）或 `Light`；標題列的太陽／月亮按鈕也能切換。"],
              ["Font size", "編輯器字體大小，範圍 11 到 24，離開欄位時套用；也可以用 `⌘` + 滾輪或 `⌘=` / `⌘-` 調整。"],
              ["Tab size", "Tab 與縮排的寬度，範圍 1 到 8。"],
              ["Indent with spaces", "使用空格縮排；關閉後改用 Tab 字元，預設開啟。"],
              ["Word wrap", "在編輯器內自動換行，`⌥Z`（`Alt+Z`）可切換。"],
              ["Line numbers", "顯示行號與摺疊欄，預設開啟。"],
              ["Show whitespace", "標示空格、Tab 與行尾空白，預設關閉。"],
              ["Close brackets and quotes automatically", "輸入時自動補上 `)`、`]`、`}` 或引號，預設開啟。"],
              ["Trim trailing whitespace on save", "儲存編輯器中顯示的檔案時，移除每行結尾的空格與 Tab，預設關閉。"],
              ["End files with a newline on save", "儲存編輯器中顯示的檔案時，在結尾補上換行，預設關閉。"],
              ["Hide dot files", "在檔案總管中隱藏以 `.` 開頭的名稱，預設關閉。"],
              ["Group Git ignored files", "將根目錄的 Git 忽略項目分組，檔案總管底部的 `Group ignored` 也能切換；預設開啟，選擇會儲存在本機，與專案搜尋的納入忽略檔案選項各自獨立。"],
              ["Check for updates on startup", "啟動後不久檢查是否有新版本，預設開啟。"],
              ["Watcher excluded paths", "檔案監看要忽略的路徑，例如建置輸出。"],
            ],
          },
          { t: "p", text: "從 `View › Settings`（繁體中文介面為 `檢視 › 設定`）或 `⌘,`（`Ctrl+,`）開啟設定。設定分為介面、編輯器、儲存、檔案總管與更新幾組；最下方的 `Restore defaults` 需要再按一次確認，會還原語言以外的所有設定。本文件中的介面名稱以英文介面為準；切換為繁體中文後，選單與按鈕會顯示對應的中文名稱。" },
          { t: "h3", text: "資料存放位置" },
          {
            t: "list",
            items: [
              "工作區檔案留在原本的路徑，pude 不會複製到其他地方。",
              "設定、最近的資料夾與工作區，以及工作階段資訊存放在本機 WebView 儲存空間；`.pdw` 工作區檔案則存放在你選擇的位置。",
              "復原檢查點使用 IndexedDB，並有本機備援；清除應用程式儲存空間可能會移除它們。",
              "已安裝的外掛會複製到應用程式資料目錄。",
              "錯誤診斷會寫入應用程式日誌目錄中的小型輪替日誌，常見的憑證格式會被遮蔽，不會傳送到任何地方。",
            ],
          },
        ],
      },
      {
        id: "shortcuts",
        file: "shortcuts.md",
        nav: "快捷鍵",
        blocks: [
          { t: "h2", text: "鍵盤快捷鍵" },
          {
            t: "table",
            head: ["動作", "macOS", "Windows"],
            rows: [
              ["儲存", "`⌘S`", "`Ctrl+S`"],
              ["另存新檔", "`⌘⇧S`", "`Ctrl+Shift+S`"],
              ["全部儲存", "`⌘⌥S`", "`Ctrl+Alt+S`"],
              ["開啟檔案", "`⌘O`", "`Ctrl+O`"],
              ["開啟資料夾", "`⌘K ⌘O`", "`Ctrl+K Ctrl+O`"],
              ["關閉分頁", "`⌘W`", "`Ctrl+W`"],
              ["重新開啟關閉的分頁", "`⌘⇧T`", "`Ctrl+Shift+T`"],
              ["下一個／上一個分頁", "`⌃⇥` / `⌃⇧⇥`", "`Ctrl+Tab` / `Ctrl+Shift+Tab`"],
              ["尋找", "`⌘F`", "`Ctrl+F`"],
              ["尋找下一個／上一個", "`Enter` / `⇧Enter`", "`Enter` / `Shift+Enter`"],
              ["搜尋專案文字", "`⌘⇧F`", "`Ctrl+Shift+F`"],
              ["跳至檔案", "`⌘P`", "`Ctrl+P`"],
              ["取代", "`⌘⌥F`", "`Ctrl+H`"],
              ["跳至行號", "`⌘G`", "`Ctrl+G`"],
              ["加入下一個相符項目／選取所有相符項目", "`⌘D` / `⌘⇧L`", "`Ctrl+D` / `Ctrl+Shift+L`"],
              ["切換行註解", "`⌘/`", "`Ctrl+/`"],
              ["摺疊／展開區塊", "`⌘⌥[` / `⌘⌥]`", "`Ctrl+Shift+[` / `Ctrl+Shift+]`"],
              ["命令面板", "`⌘⇧P`", "`Ctrl+Shift+P`"],
              ["設定", "`⌘,`", "`Ctrl+,`"],
              ["切換側邊欄", "`⌘B`", "`Ctrl+B`"],
              ["切換自動換行", "`⌥Z`", "`Alt+Z`"],
              ["Markdown 原始碼／預覽", "`⌘⇧V`", "`Ctrl+Shift+V`"],
              ["切換終端機", "`` ⌘` ``", "`` Ctrl+` ``"],
              ["字體大小", "`⌘=` / `⌘-` / `⌘0`，或 `⌘` + 滾輪", "`Ctrl+=` / `Ctrl+-` / `Ctrl+0`，或 `Ctrl` + 滾輪"],
            ],
          },
          { t: "note", text: "自訂快捷鍵規劃中。" },
        ],
      },
      {
        id: "plugins",
        file: "plugins.md",
        nav: "外掛",
        blocks: [
          { t: "h2", text: "製作外掛" },
          {
            t: "p",
            text: "外掛是一個本機資料夾，包含 `plugin.json` 宣告檔與一個 JavaScript 進入點。它在 opaque-origin 沙箱裡的 Web Worker 中執行，只能透過非同步的 `pude` API 與 pude 溝通——無法取得 DOM、CodeMirror、Tauri 或瀏覽器儲存空間。",
          },
          {
            t: "note",
            text: "外掛是你選擇信任的可執行程式碼。權限預設拒絕，安裝前會經過審核，但沙箱並不是完整的作業系統安全邊界。請只安裝來源可信的外掛。",
          },
          { t: "h3", text: "1. 撰寫宣告檔" },
          {
            t: "p",
            text: "以下是 `examples/plugins/document-case-toggle` 中可直接執行的範例。每個貢獻的命令都需要對應的 `onCommand:<id>` 事件；另外也可使用 `onLanguage:<id>`、`onFileOpen`、`onFileSave` 與 `onWorkspaceOpen`。",
          },
          { t: "code", lang: "json", code: pluginManifest },
          { t: "h3", text: "2. 撰寫進入點" },
          { t: "code", lang: "js", code: pluginEntry },
          { t: "h3", text: "3. 安裝與迭代" },
          {
            t: "list",
            items: [
              "開啟 `Plugins`，選擇 `Install local plugin` 並選取資料夾。",
              "檢視要求的權限，只核准外掛真正需要的。按 `Cancel` 會保留現有版本與授權。",
              "啟用外掛，並從命令面板執行它的命令。",
              "修改後使用 `Update from folder`；新版本要在你核准後才會取代舊版本。",
            ],
          },
          { t: "h3", text: "API 一覽" },
          {
            t: "table",
            head: ["權限", "呼叫", "說明"],
            rows: [
              ["`editor.read`", "`getText`、`getTextRange`、`getSelection`、`getCursor`、`getFileInfo`", "每次最多 128 Ki 個字碼單位"],
              ["`editor.write`", "`applyEdits(revision, edits)`", "最多 1,000 筆編輯；走一般的復原與未儲存狀態"],
              ["`workspace.read`", "`list`、`readFile`、`getFileInfo`、`readFileRange`", "每次 128 KiB；大型檔案以範圍讀取"],
              ["`workspace.write`", "`writeFile`", "會檢查衝突；不提供刪除"],
              ["`commands.register`", "`commands.register`", "僅限已宣告的命令"],
              ["`ui.*`", "`ui.notify`、`ui.statusBar`、`ui.quickPick`", "由 pude 繪製，文字長度有限"],
              ["`git.read`", "`git.getStatus`、`git.getDiff`", "唯讀"],
              ["`terminal.write`", "`terminal.write`", "只能寫入使用者已開啟的終端機"],
              ["`network`", "`network.fetch`", "僅限核准網域的 HTTPS"],
              ["`process.spawn:lsp`", "`lsp.start`、`send`、`cancel`、`stop`", "僅限已宣告的伺服器"],
            ],
          },
          {
            t: "p",
            text: "每次執行最多 512 個並行請求、每秒 20 個請求、30 秒逾時、請求 64 KiB 與回應 1 MiB。完整參考請見儲存庫中的 `docs/plugin-api-v2.md`。",
          },
        ],
      },
      {
        id: "installation",
        file: "build.md",
        nav: "從原始碼建置",
        blocks: [
          { t: "h2", text: "從原始碼建置" },
          {
            t: "list",
            items: [
              "Node.js `22.12+`、`24+` 或 `26+`，以及 npm `10.9+`（建議 Node.js 24）",
              "透過 `rustup` 安裝的 Rust stable，以及在 `PATH` 中的 Git",
              "macOS：Xcode Command Line Tools · Windows：MSVC C++ 建置工具與 WebView2 · Linux：Tauri 需要的 GTK/WebKit 套件",
            ],
          },
          { t: "code", lang: "bash", code: cloneCommands },
          { t: "h3", text: "常用指令" },
          {
            t: "table",
            head: ["指令", "用途"],
            rows: [
              ["`npm run tauri:dev`", "執行原生桌面應用程式"],
              ["`npm run dev`", "在瀏覽器殼層中執行桌面介面（port 5173）"],
              ["`npm run web:dev`", "本網站（port 5174）"],
              ["`npm test`", "桌面版 Vitest 測試"],
              ["`npm run tauri:build`", "建置目前平台的原生安裝包"],
            ],
          },
          {
            t: "note",
            text: "瀏覽器殼層使用記憶體中的示範工作區，不會測到原生檔案、Git、終端機或外掛安裝。",
          },
          { t: "h3", text: "送出 Pull Request 前" },
          { t: "p", text: "每個功能或行為變更都要在同一個 PR 更新相關文件：`docs/product-spec.md`、`CHANGELOG.md`、README 與中英文網站。補上快捷鍵、設定、限制、權限與平台差異，檢查截圖及 SEO metadata；未受影響的地方要在 PR 說明原因。歷史效能數字須保留原本量測的版本與日期。" },
          { t: "code", lang: "bash", code: checkCommands },
        ],
      },
    ] satisfies DocSection[],
  },
  footer: {
    tagline: "pude — pure code editor",
    built: "以 Tauri、SolidJS、CodeMirror 6 與 Rust 打造。MIT 授權。",
  },
};

const dictionaries: Record<Locale, DocsDict> = { en, "zh-Hant": zhHant };

export function t(): DocsDict {
  return dictionaries[locale()];
}

export { locale, localeHref } from "./i18n-runtime";
