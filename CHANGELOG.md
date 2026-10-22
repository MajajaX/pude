# Changelog

All notable changes to `pude` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

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
- Updated the product specification, README, English and Traditional Chinese
  website guides and all five website tour screenshots.

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
