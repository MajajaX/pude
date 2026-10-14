# Changelog

All notable changes to `pude` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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
