# pude product specification

Implemented behavior for **0.1.9** and the unreleased changes listed in the changelog. Update this specification in the same change as
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
- Right-click blank space for **Refresh** to update directory listings, open files
  and Git without reloading the renderer or interrupting projects, unsaved edits or
  terminals. Editable fields and selected text keep the native menu. Reloading the renderer restores all checkpointed projects; a window
  consumes its startup launch request only once.
- Dot files are visible by default and can be hidden in Settings. Hiding them never
  hides an opened folder, such as `~/.config` or a workspace folder named `.dotfiles`;
  only the dot files and folders inside it.
- Git-ignored names are muted. With **Group ignored** enabled, ignored root items
  appear in a collapsed group identified by a Git icon, divider and item count.
  Expanding it exposes the same file operations as other entries; the final row
  remains fully scrollable. Ignored descendants keep their normal hierarchy.
- A **FILES** bar at the top of the Explorer view holds **New file** (`+`) and **New folder**
  for the project root. Right-click a folder to create items inside it, or a file
  to create items beside it.
- In a Git repository, right-click a file or folder that is not ignored yet for **Add to
  .gitignore**. It appends one line to the `.gitignore` at the repository root, creating
  that file if needed: `/path/to/file`, or `/path/to/folder/` for a folder. The line is
  anchored and escaped so it matches only that item. Existing lines and line endings are
  kept, and a line already present is not added again. The item is hidden for the
  repository root, `.git`, ignored items and folders outside the repository. Git keeps
  tracking committed files, so the confirmation points to `git rm --cached`; Pude does not
  change the index. A name containing a line break cannot be listed. The change is a
  normal edit to `.gitignore` and shows in the Git panel.
- The Explorer context menu groups its copy actions in a **Copy** submenu: **Copy File**
  (**Copy Folder** on a folder), **Copy Name**, **Copy Path** and, inside a workspace
  folder, **Copy Relative Path**. Hovering or clicking **Copy** opens it beside the menu,
  on the left when the right edge has no room. With keyboard focus on **Copy**, the right
  arrow key opens it and focuses its first item; the left arrow key or Escape closes it
  and returns focus to **Copy**. **Paste** stays in the main menu.
- Right-click a file or folder for **Copy File** / **Copy Folder** and **Paste**, or press **Cmd+C** / **Cmd+V**
  (**Ctrl+C** / **Ctrl+V** on Windows and Linux) while its Explorer row has focus; the
  editor and terminal keep their own copy and paste. Pasting on a folder puts the item
  inside it, and pasting on a file puts it beside that file. The copied item stays
  available in every project tab of the window, so it can be pasted into another
  project, and it can be pasted repeatedly. It holds one item, is separate from the
  system clipboard, is not shared between windows and is forgotten on restart.
- Paste never replaces anything. A name already in use becomes `name copy.ext`, then
  `name copy 2.ext`. Folders copy recursively and cannot be pasted into themselves or
  their subfolders. Symbolic links are recreated rather than followed; on Windows that
  needs Developer Mode or administrator rights. Sockets, pipes and device files inside
  a folder are skipped and counted in the message. Both locations must be inside their
  project. Pasting runs in the background, one at a time, without blocking the window,
  and has no cancel. After it finishes, Explorer refreshes, expands the folder and
  selects the new item. A failed paste shows the error and removes the partial copy;
  closing the window during a paste can leave a partial copy behind.
- **Collapse folders** (the chevron in the **FILES** bar, or the command
  **Explorer: Collapse Folders**) closes every expanded subfolder below the
  workspace's top-level folders; loaded listings are kept.
- **Cmd+B** / **Ctrl+B**, **View > Hide sidebar** or **View: Toggle Sidebar** hides the
  sidebar and its resize handle so the editor uses the full width; the activity bar
  stays visible. Selecting the icon of the view already showing also hides the
  sidebar, and selecting any icon or opening project search shows it again. The
  choice lasts for the current window session only.
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

- The activity bar's **Search** icon or **Cmd+Shift+F** on macOS / **Ctrl+Shift+F**
  on Windows opens search for the active project. Selecting the **Explorer** icon or
  pressing Escape in the search input returns to files.
  A short single-line editor selection (at most 200 characters) becomes the query
  when search opens from the shortcut or **Search: Find in Project**.
- **Cmd+P** / **Ctrl+P**, **Edit > Go to file** or **Go: Go to File…** opens search in
  **Files** mode with the query selected, to open a file by name or path. It uses the
  same on-demand search and limits; there is no file index.
- Text results are grouped by file: each file shows its name, its folder dimmed beside
  it and its match count once, followed by one row per match with its line number and
  line. **Files** results list one row per file. The full relative path is in the
  tooltip.
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
  the replace button on a file's heading replaces every match in that file only.
  Replacement uses the same literal, **Match case** and Git-ignored rules as search,
  asks for confirmation first, and reports how many matches and files changed, in the
  interface language.
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
  Font License 1.1, ship inside the app and are never downloaded. Inter covers Latin
  and Latin Extended text; JetBrains Mono also covers Cyrillic, Greek and Vietnamese
  because it renders code. Interface text outside these sets, such as Cyrillic, Greek,
  Vietnamese or Chinese, falls back to the system font (PingFang TC on macOS,
  Microsoft JhengHei on Windows). Fonts are separate files, never inlined into the
  style sheet, because the content security policy only allows fonts from the app
  itself.
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
  startup. A Traditional Chinese interface starts loading its file together with the
  rest of the app, and the first frame waits for it, so text never switches language
  after it appears. Messages from Git, shells, plugins and language servers, and some
  low-level native errors, stay in their original language.
- An activity bar runs down the left edge of the window with icon-only **Explorer**,
  **Search** and **Git** views, in that order. Each icon names its view in a tooltip
  and to assistive technology; the arrow keys, Home and End move between views. The
  Git view lists the current branch at the top, and each changed file by name with its folder
  dimmed beside it.
- Notifications appear at the lower right. Errors are marked in red, are announced to
  screen readers as alerts and stay at least 6 seconds; longer messages stay up to 10
  seconds. A finished Git operation shows a one-line summary instead of Git's full
  output; when there is more to read, the notification also has **View full response**
  and stays for 10 seconds, and while the pointer is over it or it has keyboard focus.
- A window is visible as soon as it is created, on macOS and Windows, including windows
  opened with **New Window**. Until the interface renders, which takes a fraction of a
  second, it shows the dark native background (`#101214`) and a placeholder layout of
  the title bar, activity bar, sidebar and status bar. The placeholder follows the
  stored theme, so a light-theme window is light from its first painted frame, but the
  native background before that is always dark. The interface replaces the placeholder
  on the first render. Everything the interface needs at startup loads as one file, and
  the first frame waits for the Latin subsets of Inter and JetBrains Mono, so it does
  not change fonts afterwards.
- Development builds (`npm run tauri:dev`) are named pude Dev and use the identifier
  `com.pude.editor.dev`, so they keep their own settings, session data, logs and
  single-instance lock and run next to an installed pude.
- The native Git cache keeps the output of repeated read-only Git commands (status, refs,
  diffs, stash and commit file lists) until the repository changes. It holds at most 8 MiB
  per repository and 32 MiB across all repositories, evicting the least recently used
  entries first; a single output above 8 MiB is not cached and is read again. Git history
  pages are not part of this cache. Nothing expires by time.
- A window that stays hidden for 5 minutes in a row (minimized, behind other windows, or
  on another desktop, as the webview reports it) gives back memory it can rebuild. It
  closes the editors of open files that are not shown, as long as the file has no unsaved
  changes and no undo or redo history; the tab, cursor and selection stay and the file
  reloads into an editor when the tab is shown. It clears the loaded Git history commits
  when neither the Git view in the sidebar nor the history tab is open, and the history
  loads again when one is opened. It empties the native Git cache of the project's
  repository (all windows on that repository share it, so they read Git again). It never
  releases unsaved text, undo history, terminals and their scrollback, the Git
  operation log, or the Git view or history tab that is open. Returning to the window
  within 5 minutes cancels the release, and after it everything looks unchanged. With
  `PUDE_PERF_LOG=1` the release writes one `idle release:` line to the log with the
  counts of closed editors and cleared commits and the bytes of Git cache freed.
- Nothing appears above the Git action buttons while an operation runs or after it
  finishes, so the buttons never move. A running action shows a spinner on the button
  that started it (Stage all, Unstage all, staging or unstaging one file) or in the
  confirmation or input dialog that started it. A failed operation opens an error
  dialog with the Git message; for Push and Pull it also offers **Retry** next to
  **Close**.
- A successful operation shows a one-line summary in a notification. Pull shows
  `Already up to date.` or the files changed with insertions and deletions, such as
  `5 files changed, +20 −3` (`5 個檔案變更，+20 −3` in Traditional Chinese); Commit shows
  `[branch hash] subject`; Push shows the updated ref, such as `1a2b3c4..5d6e7f8 main -> main`
  or `* [new branch] main -> main`, or `Everything up to date`, because Git writes a push
  only to standard error; any other operation shows the first line of Git's output,
  shortened to 100 characters, or `Git operation completed.` when Git printed nothing
  usable. The summaries pude writes are translated; Git's own text stays in English. When
  the response says more than the summary, the notification also has **View full
  response**, which opens the **LOG** tab with that entry expanded.
- The **LOG** tab (**操作紀錄** in Traditional Chinese) is the last of the Git view
  tabs **STATUS / HISTORY / STASH / LOG**; the full history tab does not have it. It
  lists the Git operations run from pude in this window for the current project,
  newest first. Each entry shows whether it succeeded, its action, time, duration and
  one-line summary; selecting it shows the command that ran (such as `git pull`) and the
  complete response, exactly what Git printed (standard output then standard error), or
  the error message of a failed operation, in a scrollable monospace block with a
  **Copy** button. When Git printed nothing, the entry says `(no output)`. The log
  records Stage all, Unstage all, discards, Commit, Stage all and commit, Push, Pull,
  stash operations, branch switch, create and delete, and worktree creation, whether
  they succeed or fail. Staging or unstaging a single file, status, history and diff
  reads are not recorded. The log is kept in memory only: it holds the latest 50
  entries per project, each response is limited to 64 KiB (longer ones end with a
  truncation marker), and it is gone when the window closes. Git's own text stays in
  English.
- History loads 200 commits at a time. The next page starts loading while 40 loaded
  rows remain below the viewport, so scrolling rarely reaches the end; when the
  branch filter hides a whole page, **Load older commits** continues. Loading a page
  keeps the rows on screen and keyboard focus in place. A commit listed early because
  a branch or tag points at it moves below its children once they load. History
  reloads after commits, push, pull, branch and stash operations,
  and after Git changes made outside pude, in both the sidebar and the full
  history tab; a reload starts again from the newest commits. A thin bar under the
  toolbar shows a reload without moving the list.
- The sidebar history uses two-line rows and the full history tab uses compact
  single-line rows. The graph column stays narrow in repositories with many branches,
  and lanes move closer together instead of crowding out the commit message.
- Selecting a commit opens its details below the list, with its subject, hash, author,
  age and changed files; selecting it again, the close button or Escape closes them.
  Resting the pointer on a row shows its full metadata after a short delay, and a
  commit whose parent is not loaded yet says so there. History search shows the
  current match and the match count, such as `3/12`.
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
- The app bundle contains `LICENSE`, `THIRD_PARTY_NOTICES.md` and a shorter
  `THIRD_PARTY_LICENSES.md`. The bundled copy keeps every third-party license and
  notice text and lists the license of each package; the build generates it from the
  complete repository file (`scripts/write-bundled-licenses.mjs`) and leaves out the
  verification inventory (archive URLs, lock digests, source hashes, review notes).
  The complete file stays in the repository and is attached to every GitHub release.
- When an update is available, **Update [version]** appears immediately to the right
  of the branch name in the lower-left status bar. Clicking downloads the update;
  **Downloading…** becomes **Restart and update** when ready. Restart follows the
  existing unsaved-changes flow. Errors open About with details and a retry action.
  **Help > About pude** still provides manual checks and release notes. The status
  button is transient; startup-check preferences remain local and persistent.

## Validation and documentation

Native checks verify Explorer terminal actions with `pwd` for a folder, nested file
and root file, and verify the grouping checkbox after restart. Unit, browser and
native CI cover search, path handling, scrolling, terminal lifecycle and previews;
browser tests run in both Chromium (WebView2) and WebKit (WKWebView). Biome checks
formatting and lint rules, and `THIRD_PARTY_NOTICES.md` must list every direct
dependency at its locked version.
All required checks must pass before merge and release. Use the documentation
checklist in [releasing.md](releasing.md); benchmark claims retain their original
measured version and date until new measurements replace them.
