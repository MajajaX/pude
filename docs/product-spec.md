# pude product specification

Implemented behavior for **0.1.5**. Update this specification in the same change as
a feature or behavior change, together with the changelog, README and applicable
English and Traditional Chinese website copy. User instructions live at
[pude.dev/docs](https://pude.dev/docs) and [pude.dev/zh/docs](https://pude.dev/zh/docs).
Release targets are Windows 11 x64 and macOS 14+ Apple Silicon; Linux has source CI
coverage and no published installer yet.

## Projects and Explorer

- A window can hold multiple project tabs. Each project retains its open files,
  unsaved edits, undo history, Git view and running terminals while inactive.
- Opening a folder reads its top level. Subfolders load on expansion and long
  trees render visible rows only. File/folder creation, rename, copy name, copy
  paths and native reveal are available from Explorer. Delete uses recoverable system trash.
- Dot files are visible by default and can be hidden in Settings.
- Git-ignored names are muted. With **Group ignored** enabled, ignored root items
  appear in a collapsed group identified by a Git icon, divider and item count.
  Expanding it exposes the same file operations as other entries; the final row
  remains fully scrollable. Ignored descendants keep their normal hierarchy.
- A **FILES** bar under the sidebar tabs holds **New file** (`+`) and **New folder**
  for the project root. Right-click a folder to create items inside it, or a file
  to create items beside it.
- **Group ignored** is a checkbox at the left of the Explorer footer's plugin
  count. It defaults to on, persists locally across restarts, and shows ignored
  items among normal entries when off. It does not change `.gitignore` or search
  filters.
- A new, empty project tab lists **Recent folders** and **Recent workspaces**
  separately in Explorer, eight of each, newest first. Entries whose folder or
  workspace file no longer exists are removed at startup. Windows of the app share
  the lists.

## Workspaces

- A project tab can show several folders. **File > Add folder to workspace…**,
  the **Add folder to workspace** button in the **FILES** bar or the command
  **Workspaces: Add Folder to Workspace…** adds one. Explorer then shows a
  **<name> (Workspace)** row with each folder's tree below it; the tab is named after
  the workspace file, or `<first folder> +N` before it is saved, and its tooltip
  lists every folder.
- Right-click a folder row and choose **Remove Folder from Workspace** to remove it;
  Rename and Delete are not offered on folder rows. Files from a removed folder
  stay open.
- The first folder owns Git, terminals, plugins and language servers. When it is
  removed, the next folder takes them over, as when switching project tabs.
  **New file** and **New folder** in the **FILES** bar create items in the first
  folder; right-click any folder to create items there. Git-ignored grouping and
  Git badges apply to the first folder's repository.
- Project search and the file watcher cover every folder. With several folders,
  search results start with their folder's name. Relative watcher excludes apply
  inside every folder.
- **File > Save workspace as…** (or **Workspaces: Save Workspace As…**) writes a
  `.pdw` workspace file: UTF-8 JSON with `"version": 1` and a `folders` list of
  `{ "path": … }` entries, at most 64. Folders that share a parent folder with the
  workspace file are stored relative to it with `/`, so the file still works when the
  whole tree moves; others are stored as absolute paths. While a tab has a workspace
  file, adding or removing folders rewrites it.
- **File > Open workspace…** (or **File: Open Workspace from File…**) opens a
  `.pdw` file in a new project tab, or switches to the tab that already shows it.
  Missing folders are skipped with a notice; a file without any existing folder,
  invalid JSON or a newer `version` is refused. `pude path/to/team.pdw` opens a
  workspace file from the command line.
- Sessions restore each tab's folders and workspace file. Workspace files are
  available in the desktop app; the browser preview shows one folder per tab.

## Dock and taskbar menu

- On macOS, right-click pude in the Dock for **New Window**, **Recent Folders** and
  **Recent Workspaces**. On Windows, right-click pude on the taskbar (pinned or
  running) or in Start for the same entries in its Jump List; Windows lets you
  remove entries from the list.
- **New Window** opens an empty window. Choosing a recent folder or workspace opens
  it as a new project tab in the last focused pude window, or switches to the tab
  that already shows it. Only when no window is open does it open a new window.
- The menus show the same lists as Explorer's recent lists, updated when they
  change. The command-line forms are `pude --new-window` and
  `pude --reuse-window <folder or .pdw file>`. Linux has no launcher menu yet.

## Project search

- The sidebar has **EXPLORER / GIT / SEARCH** tabs. **SEARCH** or **Cmd+Shift+F**
  on macOS / **Ctrl+Shift+F** on Windows opens search for the active project.
  Selecting **EXPLORER** or pressing Escape in the search input returns to files.
- Results show the file name first, its folder dimmed beside it and a line-number
  badge for text matches; the full relative path is in the row tooltip.
- **Text** finds literal text in saved UTF-8 files. **Files** matches a filename
  or relative path. Both support **Match case**; matching is case insensitive by
  default. Paths in results use `/`, including on Windows.
- Git-ignored files are excluded by default. **Include Git ignored files** changes
  this independently of Explorer grouping. Search includes dot files, always
  excludes `.git`, and does not follow symlinks. No background index is created.
- Selecting a text result opens the file, centers its match in the editor where
  scrolling allows, and selects the matching text to highlight it. Selecting a path
  result opens that file. Unsaved editor buffers are not searched: save first to
  include current edits. Search has no regex mode.
- The chevron left of **Text / Files** shows **Replace with** and **Replace all**
  for text search. **Replace all** (or Enter in the replacement field) replaces every
  match of the query in the project, including files beyond the 300 listed results;
  the replace button on a hovered result replaces every match in that file only.
  Replacement uses the same literal, **Match case** and Git-ignored rules as search,
  asks for confirmation first, and reports how many matches and files changed.
- Replace rewrites saved files atomically on disk and keeps line endings and BOMs.
  Files with unsaved editor changes are skipped and counted; open files without
  changes reload. Edit > Undo cannot reverse a project-wide replacement. Binary,
  non-UTF-8 and files over 2 MiB are left unchanged. One replacement stops after 30
  seconds and reports that some files were not checked. Replacing across files is
  available in the desktop app.
- The editor can scroll past the final line so matches near the end can be centered.
- Queries run after a short typing delay. Changing a query, closing search or
  switching projects cancels obsolete work; stale results do not replace new ones.
- A query is at most 4,096 bytes. Each search is bounded by 300 results, 50,000
  directory entries, 100 MiB read and eight seconds. Text search skips files over
  2 MiB, binary/unsupported encodings and unreadable files, with a skipped count.
  Reaching a limit displays a notice asking for a narrower query.

## Interface and readability

- The interface uses the bundled Inter variable font. The editor, terminals, diffs
  and other code text use the bundled JetBrains Mono variable font. Both are SIL Open
  Font License 1.1, ship inside the app and are never downloaded. Text outside their
  character sets, such as Chinese, falls back to the system font (PingFang TC on
  macOS, Microsoft JhengHei on Windows).
- Interface text is 13 px, with 11–12 px for labels and metadata; the terminal uses
  13 px. The editor font size setting is unchanged (default 14, range 11–24).
- Primary, secondary and hint text reach at least 4.5:1 contrast against sidebar and
  panel backgrounds in both dark and light themes.
- The interface is available in English and Traditional Chinese. **Settings >
  Language** offers **System default** (the default), **English** and **繁體中文**.
  System default uses Traditional Chinese when the system's preferred languages
  include `zh-Hant`, `zh-TW`, `zh-HK` or `zh-MO`, and English otherwise. Changing the
  setting updates open windows without a restart and is saved with the other
  settings. The Dock and taskbar menu follow the same language.
- Translations are bundled with the app and never downloaded. Each language is a
  separate file loaded only when that language is in use, so English adds nothing to
  startup. Messages from Git, shells, plugins and language servers, and some
  low-level native errors, stay in their original language.
- The **EXPLORER / GIT / SEARCH** tabs fill the sidebar width. The Git view lists
  the current branch at the top, and each changed file by name with its folder
  dimmed beside it.

## Editing and Markdown

- CodeMirror provides syntax highlighting, file-local find/replace, multiple
  cursors, undo/redo and indentation. File tabs support reorder, pin, Save As and
  reopening closed tabs.
- Hovering a find bar button shows what it does: **Match case**, **Match whole
  word**, **Use regular expression**, **Find next (Enter)**, **Replace next match**,
  **Replace all matches in this file** and **Close find (Escape)**. Screen readers
  announce the same names and whether each option is on.
- `.env` and `.env.*` files use shell syntax highlighting for variable assignments,
  quoted strings, numbers, expansions and comments. The status bar labels them **Dotenv**;
  they follow the same large-file parsing limits as other languages.
- Markdown starts in source mode. The lower-right **Source / Preview** control
  switches the project's Markdown files to a rendered view. The choice follows
  Markdown files in that project, including after switching file types or diffs.
- Preview fills the editor's available width with modest responsive side padding.
  Body text is legible in both dark and light themes. Switching modes never changes
  the source text.
- UTF-8 and UTF-8 with BOM are accepted. Text files are limited to 20 MiB. Above
  5 MiB, large-file mode disables heavy parsing and Markdown preview while keeping
  editing and file-local search.

## Integrated terminals

- The panel opens with **Cmd+`** / **Ctrl+`**. A normal new terminal uses the project
  root; xterm.js and a PTY start only when a terminal first appears.
- Drag the panel's top edge to change its height, or focus the edge and press the
  Up/Down arrow keys to change it by 16 px. The height ranges from 160 px to
  1,200 px, always leaves at least 120 px for the editor, and is saved with the
  settings for every project and window.
- Explorer's **Open in Integrated Terminal** creates a separate terminal tab in
  the selected folder, or in the parent directory of a selected file. It shows the
  panel and keeps existing tabs' directories and processes intact. The tab belongs
  to the originating project even when its starting directory is a subfolder.
- Hiding the panel or switching projects keeps sessions running. Closing a tab,
  project or window stops its process tree. Ctrl+C interrupts the foreground program
  and returns to the same shell, as in the operating system's terminal. When a shell
  ends, the tab shows its exit status and a **Restart terminal** button; pude never
  starts a replacement shell on its own. Project state refreshes do not restart
  sessions.
- Windows starts PowerShell 7 (`pwsh.exe`) when it is on `PATH`, otherwise Windows
  PowerShell, matching Windows Terminal; `ComSpec` is no longer used. The shell runs
  behind a small bootstrap process that survives Ctrl+C and Ctrl+Break, so an
  interrupt reaches the shell and its jobs without ending the terminal. Unix uses `SHELL` as a login
  shell, falling back to `/bin/sh`. A project `.venv`, `venv` or `env` is activated
  for new terminals when present. Scrollback holds 5,000 lines.
- Terminals run with the user's account and can access the network and files
  outside the project. Windows assigns processes to a Job before releasing the
  shell bootstrap. Linux cleanup requires kernel 5.1+, permitted pidfd signals and
  readable `/proc`; processes that deliberately leave the session are excluded.

## Saves, Git, plugins and updates

- Saves are atomic, queued per file and preserve LF/CRLF. External changes offer
  comparison or explicit recovery choices. Local checkpoints recover the last
  completed snapshot of unsaved work.
- Git operations use system Git, update from events, and include status, history,
  diffs, staging, commits, branches, stash, push/pull and worktrees. Destructive
  operations require explicit confirmation. Full merge/rebase editing is planned.
- The Git view always shows its action groups (**Changes**, **Sync**, **Branches**,
  **Stash**); they no longer collapse.
- History loads 60 commits at a time. Scrolling near the end loads the next page
  automatically; when the branch filter hides a whole page, **Load older commits**
  continues. History reloads after commits, push, pull, branch and stash operations,
  and after Git changes made outside pude, in both the sidebar and the full
  history tab; a reload starts again from the newest commits.
- When the repository has stashes, a **STASH** tab with their count appears next to
  **STATUS / HISTORY**. Each stash shows its message, `stash@{N}` and age; expanding
  it lists the changed files, with untracked files marked `?`, and selecting a file
  opens the stashed change in the diff view. **Apply** keeps the stash, **Pop**
  applies and removes it, and the trash button drops it; each asks for confirmation.
  If the stash list changed since it was shown, the action is refused so the wrong
  stash is never touched.
- Local plugins use permission-reviewed sandboxed workers. The authoritative
  permission and API contract is [Plugin API 2](plugin-api-v2.md).
- Settings, sessions and recovery remain local. There is no account, cloud sync
  or telemetry. Startup update checks can be disabled. Download and installation
  require user actions and verify an updater signature. Windows uses the raw NSIS
  executable; macOS uses the signed/notarized app archive and DMG.
- When an update is available, **Update [version]** appears immediately to the right
  of the branch name in the lower-left status bar. Clicking downloads the update;
  **Downloading…** becomes **Restart and update** when ready. Restart follows the
  existing unsaved-changes flow. Errors open About with details and a retry action.
  **Help > About pude** still provides manual checks and release notes. The status
  button is transient; startup-check preferences remain local and persistent.

## Validation and documentation

Native checks verify Explorer terminal actions with `pwd` for a folder, nested file
and root file, and verify the grouping checkbox after restart. Unit, browser and
native CI cover search, path handling, scrolling, terminal lifecycle and previews.
All required checks must pass before merge and release. Use the documentation
checklist in [releasing.md](releasing.md); benchmark claims retain their original
measured version and date until new measurements replace them.
