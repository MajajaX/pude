# Changelog

All notable changes to `pude` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Dependency update: Tauri 2.12.5.

### Fixed

- Website: scroll animations play again. Sections fade in as they come into view, and
  scroll-linked effects on the home page and docs follow the page again. In 0.1.9 a
  script error during page load stopped them.

## [0.1.9] - 2026-11-12

### Added

- **Generate key** in the `.env` table toolbar opens the random value generator without
  choosing a row, including in an empty file, and can copy the value or add it as a new
  variable. A new variable's row also has a ✦ button that opens the generator.
- **Copy** and **Paste** for files and folders in Explorer, from the context menu or
  `Cmd/Ctrl+C` and `Cmd/Ctrl+V` on a focused row. The copied item stays available when
  you switch project tabs, so it can be pasted into another project. Paste never
  overwrites: a name in use becomes `name copy.ext`. A folder cannot be pasted into
  itself, and symbolic links are recreated rather than followed.
- **Add to .gitignore** on the Explorer context menu lists a file or folder in the
  repository's root `.gitignore`, matching only that item. It appears for items inside a
  Git repository that are not ignored yet, and warns when Git still tracks the item.
- **Terminal: Trust Python Environment** and **Terminal: Stop Trusting Python
  Environment** in the command palette. The choice is remembered for each project
  folder on this machine.
- The homepage shortcut list adds **Add next match**, **Select all matches**,
  **Word wrap** and **Markdown preview**.
- Releases verify the update signatures against the configured public key before
  anything is uploaded, and `SHA256SUMS.txt` also covers the update package, both
  signatures and `latest.json`.
- `.env` table values are masked each time the table opens. **Show values** in the
  toolbar reveals them, and a value being edited always shows its text.
- If the interface fails to render, the window shows an error message and **Reload
  window** instead of a broken screen; unsaved changes come back from recovery.
- The command palette shows the **Edit: Replace** shortcut: **Ctrl+H** on Windows and
  Linux, **⌥⌘F** on macOS.

### Changed

- Dependency updates: Solid 1.9.18, notify 8.2.1, Tokio 1.54.1, uuid 1.29.0 and
  tauri-build 2.7.4, plus vite-plugin-solid 2.11.15 and Vitest 5.1.0 for builds and
  tests, and zizmor-action 0.8.1 in CI.
- **Copy**, **Copy Name**, **Copy Path** and **Copy Relative Path** on the Explorer context
  menu moved into one **Copy** submenu, where copying the item reads **Copy File** or
  **Copy Folder**. Hover, click or press the right arrow key to open it; the left arrow
  key or Escape closes it.
- Explorer, Search and Git moved to an icon-only activity bar on the left edge of the
  window, in that order. Selecting the icon of the view already showing hides the
  sidebar; the bar stays visible while the sidebar is hidden.
- Git history loads 200 commits per page and starts the next page before you reach the
  end. Selecting a commit opens details with its subject, author and age, and the
  panel no longer takes space when nothing is selected. The full history tab uses
  compact rows, the graph column stays narrow with many branches, and refreshing no
  longer shifts the list. Commit tooltips wait for the pointer to rest.
- Typing in documents of 1 MiB or more no longer rewrites the full recovery checkpoint
  about every 0.6 seconds. Checkpoints now land within about 5 seconds up to 5 MiB and about
  15 seconds above that, so a crash or forced kill can lose that much recent typing.
  Smaller documents are unchanged, and leaving or closing the window still writes
  pending checkpoints immediately.
- Terminals no longer activate a project's `.venv`, `venv` or `env` by themselves,
  because a cloned repository could otherwise put its own programs ahead of the
  system ones. The terminal prints a one-line hint until you trust the folder.
- `.env` table cells save when you leave the field or press Enter instead of on every
  keystroke. A variable needs a name before it is written, and editing a value keeps
  its quote style and multi-line layout.
- The GitHub Release is created as a draft, verified, published and checked again. It
  returns to a draft if the public check fails, so a broken `latest.json` is never
  served.
- `latest.json` needs both platforms unless `--allow-partial` is passed.
- The website shows **Published release** and the download buttons only when the
  build is given the tagged release URL of the version it shows.
- The website sends security and cache headers, and the build checks that every inline
  script is covered by the content security policy.
- The README and website state that the VS Code comparison was measured with pude
  0.1.2. The 0.1.7 installers are 5.6 MB on macOS and 4.3 MB on Windows.
- Directory listings measure their size without building every entry twice, plugin
  network requests reuse their connection while a redirect stays on the same
  addresses and do their file checks off the async runtime, and slow Git operations
  poll less often.
- Rust tests run with `node scripts/run-rust-tests.mjs`, as in CI, and Clippy blocks the
  build on every platform.
- Desktop dependencies are pinned to exact versions, including `vite` 8.3.5 and
  `@tauri-apps/cli` 2.12.4, and `wrangler` is pinned as a development dependency.
- The terminal panel toggles with **Ctrl+`** on every platform. On macOS, **Cmd+`**
  stays the system shortcut for switching between pude windows.
- Project search groups text results by file: each file shows its match count once,
  and the replace button on its heading changes only that file.
- Error notifications are marked in red, announced as alerts and stay at least 6
  seconds; longer notifications stay up to 10 seconds.
- **Watcher excluded paths** moved from **Updates** to **Explorer** in Settings.
- On macOS and Linux, saving a file with several hard links, or one whose owner or
  group the saving user cannot keep, rewrites it in place after the usual change check
  instead of replacing it, so its links and owner stay.
- Temporary save files left by a crash are removed from a folder the first time pude
  saves there, once they are an hour old.
- Git runs with English messages through `LC_MESSAGES` only, so hooks and filters keep
  the user's character set.
- The README and website list the 0.1.8 installer sizes (5.6 MB on macOS, 4.4 MB on
  Windows); size on disk, memory and launch time remain the 0.1.2 measurements.
- Dependency updates: Solid 1.9.19, Vite 8.3.8 and vite-plugin-solid 2.11.16, plus
  fake-indexeddb 6.2.8, Playwright 1.65.0 and wrangler 4.160.0 for tests and deploys.
- The website deploy job finds the published release of the current version by
  itself, so no release URL has to be set by hand, and runs the wrangler version
  pinned in `package.json`.
- `npm run check` runs Biome, which now formats the TypeScript, JavaScript and CSS
  sources, and checks that `THIRD_PARTY_NOTICES.md` lists every direct dependency at
  its locked version. `npm test` runs every unit test, and the browser tests also run
  in WebKit. `THIRD_PARTY_NOTICES.md` is now in English and lists the direct
  dependencies it was missing.
- The website's social preview image is a 99 KB JPEG instead of a 769 KB PNG.
- Bundles are built only in the formats that are shipped or used for Linux source
  builds; the unused MSI installer and its WiX fragment, the unused Windows signature
  verifier and the October audit report were removed.
- The macOS release script stops when the working tree has uncommitted changes or the
  build produced no DMG.
- The startup bundle budgets sit about 2% above the measured size (168,500 bytes for
  the entry and 257,800 for all startup code), and raising one needs a reason in the
  pull request.

### Fixed

- Terminal tabs stay on one line and no longer show a scrollbar. Long names shorten, the
  selected tab scrolls into view, the mouse wheel moves the tab strip, and **New
  terminal** stays reachable with many tabs.
- Loading more Git history no longer recreates the visible rows or loses keyboard focus,
  and Git status refreshes no longer recompute the loaded history.
- Scrolling Git history no longer forces a layout measurement on every scroll event.
- Repositories with many branches or tags no longer show a process-limit error while
  loading history: the commits those refs point at are read together in one Git process.
- A commit listed early because a branch or tag points at it moves below its children
  once they load, so the graph stays connected across pages.
- A file with no extension whose whole name looks like one, such as `go`, `md`, `sh` or
  `png`, opens as plain text. It no longer gets that language or opens as an image.
- **Retry directory scan** in Explorer now reads a partially listed folder again and
  keeps it open, instead of collapsing it.
- A Git status refresh that finds nothing changed keeps keyboard focus on its row, and
  the visible rows stay correct when a message appears above the list.
- A project search that reaches its file limit still returns its results in path order.
- Clicking a Markdown link such as `#50%` no longer raises an error.
- The worktree failure title is translated in Traditional Chinese.
- Screen readers announce unsaved changes on file tabs and project tabs.
- Arrow keys in the activity bar move through **Search** without jumping into its query
  field. Clicking the icon still places the cursor there.
- Git history shows one badge for a tagged commit instead of a tag badge and a
  remote-branch badge, and tags no longer appear as remote branches in the history
  branch filter.
- A new terminal no longer occasionally shows the `pude terminal` banner twice above
  its first prompt.
- Git commit diffs and file lists accept only full commit IDs, and creating,
  switching to or deleting a branch no longer treats a typed name or start point as a
  Git option. A branch start point must now name an existing commit.
- Plugins can reach public addresses in `192.0.0.0/16` outside the reserved
  `192.0.0.0/24` and `192.0.2.0/24` ranges; they were blocked by mistake.
- Plugins can create files, and Save As can create new files on Linux, on FAT, exFAT
  and network volumes that do not support hard links.
- **Reveal in Finder** no longer leaves a finished helper process behind on macOS and
  Linux.
- Git no longer signals a process group after its leader has been reaped, which could
  hit an unrelated process that reused the ID.
- **Save all** (**⌘⌥S**) and **Replace** (**⌘⌥F**) now work on macOS, where Option
  changes the typed character.
- **Reload** after an external change adopts the disk version like the background
  reload does, so the file is no longer read a second time on focus.
- Closing a terminal while it is starting no longer leaves its exit listener behind.
- The Markdown preview no longer makes `//host/path` links clickable.
- Plugin and file notifications, such as **Created** and **Reloaded**, are translated
  in Traditional Chinese.
- Removed a duplicated sentence from `THIRD_PARTY_LICENSES.md`, a duplicate social
  preview image and three unused website images.
- With **Hide dot files** on, an opened folder whose name starts with a dot, such as
  `~/.config`, or a workspace folder like `.dotfiles` no longer shows an empty Explorer.
- Commit and history ages round to the next unit: 59.7 minutes reads "1 hour ago",
  not "60 minutes ago".
- Clearing a number field in Settings keeps its value instead of setting the minimum.
- Deleting the last variable of a CRLF `.env` file no longer leaves a stray carriage
  return.
- Ctrl+K Ctrl+O opens a folder on Linux, as on Windows.
- The project replace summary and its confirmation for all files are translated in
  Traditional Chinese.
- Cmd/Ctrl+Shift+W and Cmd/Ctrl+Shift+G no longer close the tab or open Go to line.
- Releases reuse a successful CI run on `main` whose only skipped jobs are workflow
  lint and the optional website deploy, instead of always running the whole suite
  again.

### Performance

- Project search skips files with no match before going through their lines, and scans
  fewer file details while walking a folder.
- Terminal output is copied less on its way to the screen, invalid bytes no longer slow
  long reads, and dragging a panel only tells the terminal about real size changes.
- File watcher events, Git status paths, Git history parsing, directory listing and LSP
  messages allocate less, and the Git repository cache no longer holds its lock during
  disk checks.
- Typing, scrolling and unsaved work recovery do less repeated work: selections are only
  serialized when they change, each stored session is parsed fewer times, and loading a
  Git history page no longer asks for ignored paths again.
- Window resizing checks the maximized state once resizing pauses.
- The website loads about 750 bytes less compressed JavaScript and caches screenshots for
  a day.

## [0.1.8] - 2026-11-05

### Added

- Generate random `.env` values in Hex, Base64URL, Base64, alphanumeric or UUID format,
  and insert variables above or below an existing row.
- Git sync shows upstream ahead and behind counts and per-project operation progress.
- Terminal tabs show their starting directory and status, and can be renamed for the
  session. Terminal search, clipboard and clear actions, and a persistent terminal
  font-size setting are available.

### Changed

- Dependency updates: tauri-plugin-single-instance 2.5.5, tauri-plugin-updater 2.14.1,
  Vite 8.3.5 and Tauri CLI 2.12.4.

### Fixed

- Refreshing the workspace updates file listings and Git without reloading the
  application or interrupting open projects, unsaved edits or terminals.
- Reloading restores all checkpointed projects, and a window consumes its startup
  launch request only once.

## [0.1.7] - 2026-10-28

### Added

- Editing aids: active line, matching bracket and selection-match highlighting,
  automatic closing brackets and quotes, re-indenting on a closing bracket, code
  folding from the gutter, column selection with Alt-drag, and **⌘D** / **⌘⇧L**
  (**Ctrl+D** / **Ctrl+Shift+L**) to add the next or every occurrence to the
  selection.
- The find bar shows **N of M** matches, finds the previous match with Shift+Enter
  or a new button, and starts from the selected text. Enter in the replace field
  replaces the next match; Cmd/Ctrl+Enter replaces all.
- Command palette commands to sort lines, change case, trim trailing whitespace,
  fold and unfold all, toggle comments, duplicate or delete lines, expand the
  selection, toggle word wrap, line numbers, whitespace, the sidebar and the theme,
  change the font size, copy the active file's path, reveal it, close all tabs and
  open Settings. The palette shows shortcuts, matches words in any order and lists
  recently run commands first.
- Settings for **Theme**, **Indent with spaces**, **Line numbers**, **Show
  whitespace**, **Close brackets and quotes automatically**, **Trim trailing
  whitespace on save** and **End files with a newline on save**, grouped into
  sections, plus **Restore defaults**.
- Shortcuts: **⌘,** Settings, **⌘P** go to file, **⌘B** toggle sidebar, **⌘⇧T**
  reopen closed tab, **⌘=** / **⌘-** / **⌘0** font size, **⌥Z** word wrap and **⌘⇧V**
  Markdown preview (Ctrl and Alt on Windows).
- **Collapse folders** in the Explorer **FILES** bar.
- Tab right-click menu: **Close saved**, **Close all**, **Copy Path**, **Copy
  Relative Path** and **Reveal in Finder**.
- Go to line accepts `line:column`, starts at the current line and opens from the
  **Ln, Col** status item. The status bar shows how many characters are selected.
- Explorer's right-click menu has **Copy Name**, which copies the file or folder
  name.
- `.env` files open as a table with a name and value field for each variable and
  copy buttons for the name, the value or the whole `NAME=value` line. Add, rename,
  edit and delete variables there; the lower-right **Source / Table** button switches
  back to the text editor.

### Changed

- **Close others**, **Close to right** and the new group closes keep pinned tabs.
- Reopen closed tab remembers the last ten closed tabs per project instead of one.
- **⌘⇧F** fills project search with a short selection.
- The built-in command list and the tab menu load on demand, keeping startup code
  within its budget.
- **New file** and **New folder** are now in the right-click menu of files too;
  they create the item in the file's folder.

### Fixed

- Typing a two-digit font size or tab size in Settings no longer snaps to the
  minimum after the first digit.
- The status bar shows **Tab Size** instead of **Spaces** when indenting with tabs.
- Reopening a closed tab whose file is already open switches to it instead of
  opening a second copy.
- The light theme's active-line colors are now used, and the editor's screen reader
  label is translated.
- The tab right-click menu stays inside the window near the screen edges.

## [0.1.6] - 2026-10-23

### Added

- Drag the top edge of the terminal panel to change its height, or focus the edge
  and use the Up/Down arrow keys. The height is saved, can go up to 1,200 px and
  always leaves at least 120 px for the editor.
- Workspaces: show several folders in one project tab with **File > Add folder to
  workspace…** and remove them from a folder's right-click menu. **File > Save
  workspace as…** saves the folders as a `.pdw` file, which **File > Open
  workspace…** or `pude team.pdw` opens again. Search covers every folder.
- A new project tab lists **Recent folders** and **Recent workspaces** separately.
- Right-click pude in the macOS Dock or the Windows taskbar for **New Window** and the
  recent folders and workspaces. A recent item opens as a new tab in the window you
  used last.
- Project search can replace: open **Replace with** from the chevron beside
  **Text / Files**, then replace every match in the project or in one file. Files
  with unsaved edits are skipped.
- The Git view shows a **STASH** tab when the repository has stashes, with each
  stash's files and diffs and **Apply**, **Pop** and drop actions.
- Git history loads older commits automatically as you scroll near the end.
- Traditional Chinese interface. **Settings > Language** chooses **System default**,
  **English** or **繁體中文**, and switching applies right away. The translation is
  bundled and only loaded when Traditional Chinese is in use.

### Changed

- Git history refreshes after commits, push, pull, branch and stash operations and
  after Git changes made outside pude, instead of only when HEAD moves.
- The Git action groups are always shown instead of collapsing under **Git actions**.
- Find bar buttons explain themselves on hover, for example **Match whole word** and
  **Use regular expression**.

### Fixed

- The last terminal row is no longer cut in half, for example after Ctrl+C prints a
  new prompt at the bottom. The terminal now fits its rows to the space inside the
  panel padding, and the space under the last row matches the terminal background.

## [0.1.5] - 2026-10-22

### Changed

- On Windows the terminal starts PowerShell 7 when it is installed, otherwise Windows
  PowerShell, instead of `cmd.exe` from `ComSpec`, matching Windows Terminal.
- The terminal no longer restarts the shell by itself after Ctrl+C. When a shell ends,
  the tab shows its exit status and the **Restart terminal** button.
- Interface text is larger and easier to read. The app now bundles the open-source
  Inter typeface for the interface and JetBrains Mono for the editor, terminals and
  diffs (both SIL Open Font License 1.1), so text looks the same offline and on every
  platform. Chinese text falls back to the system font.
- Secondary and hint text has stronger contrast in both dark and light themes and
  now meets WCAG AA (at least 4.5:1) against sidebar and panel backgrounds.
- The **EXPLORER / GIT / SEARCH** tabs fill the sidebar width. New file and New
  folder moved to a **FILES** bar under the tabs, and Explorer rows are taller.
- The Git view shows the current branch at the top and lists each change by file
  name with its folder dimmed beside it. Project search results use the same layout
  with a line-number badge; hover a row for its full path.
- Updated Tauri to 2.12.3.
- Updated the product specification, README, English and Traditional Chinese
  website guides and all five website tour screenshots.

### Fixed

- Ctrl+C in a Windows terminal no longer ends the whole session. The shell bootstrap
  now ignores console interrupts, so stopping a dev server such as `nuxt dev` returns
  to the same prompt with its directory, environment and history intact.

### Security

- Updated the locked `rustls-webpki` dependency to 0.103.16 for
  [RUSTSEC-2026-0382](https://rustsec.org/advisories/RUSTSEC-2026-0382.html).

## [0.1.4] - 2026-10-20

### Added

- Syntax highlighting for `.env` and `.env.*` files, labeled Dotenv in the status bar.
- An update button beside the branch name in the lower-left status bar, with
  download, downloading and restart states using the existing signed update flow.

### Changed

- Project search now has its own **SEARCH** tab beside **EXPLORER** and **GIT**.
  Selecting a text result centers and highlights the match in the editor.
- Updated the README, product specification, English and Traditional Chinese website
  copy and guides for search, dotenv files, terminals and the update button, and
  refreshed all five website tour screenshots.

### Fixed

- Switching project tabs no longer resets terminals when their workspace path has
  not changed. Terminal tabs, output, input and running processes stay intact.
- Ctrl+C shell recovery accepts shell-specific exit statuses and survives terminal
  device replies, while explicit user commands such as `exit` end the session.
- Mobile website tour placeholders use valid image source URLs without browser
  parsing warnings.
- Release artifact collection excludes CI diagnostics retained from earlier failed
  attempts of the same workflow run.

## [0.1.3] - 2026-10-19

### Added

- Project text and file-path search from the Explorer toolbar or `⌘⇧F` /
  `Ctrl+Shift+F`, with match case, optional Git-ignored files and results that open
  at the matching line. Search reads saved files on demand without an index.
- **Open in Integrated Terminal** in Explorer context menus. Folders open a new
  terminal tab in that directory; files use their parent directory.
- A persistent **Group ignored** checkbox beside the Explorer footer's plugin
  count, enabled by default.

### Changed

- Git-ignored groups use a Git icon, divider and item count to distinguish them
  from folders.
- Markdown preview uses more of the available width, smaller side margins and
  clearer body text in both themes.
- Updated Tauri to 2.12.1 and the updater to 2.14.0. Windows updates use the signed
  raw NSIS payload without the unused legacy ZIP extractor; Rust dependency checks
  verify advisories, licenses and sources for each supported CI platform.
- Updated the website's English and Traditional Chinese feature descriptions,
  guides, shortcuts and social preview assets. Added a product specification and
  required documentation updates alongside future feature changes.

### Fixed

- The last file in an expanded Git-ignored group is no longer clipped by the
  Explorer's scroll padding.
- Project search accepts slash-separated file paths on Windows.
- The Windows terminal bootstrap test uses a deterministic subprocess fixture,
  while retaining native shell and process-tree cleanup coverage.

## [0.1.2] - 2026-10-15

### Changed

- Git-ignored files and folders have gray names in Explorer. Ignored items at the
  project root are collected in a collapsed **Git ignored** group and remain
  available for normal file operations when expanded.
- Explorer context menus use clearer text colors in both themes.
- Markdown files share the project's source or preview mode, including when
  switching through other file types or returning from a Git diff.
- Updated CodeMirror, SolidJS, Tauri tooling and Rust dependencies. Both the desktop
  app and website now build with Vite 8.3.4.

### Fixed

- Ctrl+C returns the terminal to an editable shell. If the shell itself exits
  because of the interrupt, it restarts automatically in the same tab while
  preserving prior output and scrollback. An explicit `exit` still ends the session.
- Linux terminal cleanup now includes background job-control groups and processes
  with live worker threads, and reports writes attempted after the shell exits.
- Linux source builds use the native recoverable trash service for deleted files.

### Development

- Added Ubuntu native Rust checks alongside macOS and Windows CI.

## [0.1.1] - 2026-10-14

The first release with in-app updates. It adds the Windows 11 x64 installer that
0.1.0 did not include.

### Added

- Windows 11 x64 installer (`pude-windows-x64-setup.exe`, unsigned).

### Changed

- The Explorer now shows dot files by default. Turn **Hide dot files in Explorer** on in
  Settings to hide them again.

### Fixed

- On macOS, stopping a Git command or a terminal no longer reports a cleanup failure
  when all of its processes had already exited.

### Updates

- In-app updates: pude checks GitHub Releases for a newer signed version shortly after
  startup (turn it off in Settings) and from Help > About pude. Choosing **Download
  update** and then **Restart and update** installs it after the normal quit
  check for unsaved changes. Versions before this one must be updated by hand once.

## [0.1.0] - 2026-10-13

The first public release of pude, a local-first desktop code editor. This release
ships for macOS 14+ on Apple Silicon; the Windows 11 x64 build follows.

### Editor

- Open folders as project tabs in the header. Each project keeps its own files,
  unsaved edits, undo history, search, Git view and terminals while in the
  background, and tabs restore in their saved order.
- Lazy Explorer, multiple windows, pinned file tabs, Save As, find and replace,
  and syntax highlighting for common languages through CodeMirror 6.
- Markdown source and rendered preview, plus an image preview.
- Safe saves: atomic replacement, preserved LF/CRLF line endings, external change
  detection with Compare, Reload or Keep, and local crash recovery for unsaved
  edits.

### Git

- Status, staging, commits, branches, stash, push and pull through the system Git.
- Commit graph, per-commit file lists and full-file diffs.

### Terminal

- Multiple terminal sessions per project, started on demand with xterm.js and a
  native PTY. Commands keep running while you switch projects.
- On macOS the terminal starts a login shell, so it sees the same `PATH` as
  Terminal.app even when pude is launched from Finder.

### Plugins

- Local plugin installation, updates and uninstall with permission review and
  revocation.
- Plugin API 2 with commands, events, document edits, workspace access, HTTPS
  requests through a host proxy and a restricted language-server process manager.
  API 1 plugins remain supported.

### Platform

- Native macOS title bar with system traffic lights; custom window controls on
  Windows and Linux.
- Windows Explorer "Open with pude" folder context menu.
- No automatic updates and no network access at startup. The About dialog can
  check for a newer release when you click it.
