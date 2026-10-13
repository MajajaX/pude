<p align="center">
  <img src="apps/web/public/pude-logo.png" alt="pude logo" width="96" height="96">
</p>

<h1 align="center">pude</h1>

<p align="center">
  <strong>pure code editor</strong> — a fast, local-first desktop code editor for focused work.
</p>

<p align="center">
  <a href="https://github.com/MajajaX/pude/releases/latest">Download</a> ·
  <a href="docs/plugin-api-v2.md">Plugin API</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3ddc97" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/platforms-Windows%2011%20%7C%20macOS%2014%2B-555" alt="Windows 11 and macOS 14+">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20Rust-555" alt="Built with Tauri 2 and Rust">
</p>

![pude editor window](apps/web/public/shots/editor.webp)

## Why pude

pude opens a folder and gets out of your way. It starts fast, stays light and keeps
everything on your machine: no account, no cloud sync, no telemetry and no background
indexing. Features load only when you use them.

## Features

- **Project tabs** — open several folders in one window. Each project keeps its own
  files, unsaved edits, undo history, Git view and terminals.
- **Editor** — CodeMirror 6 with syntax highlighting, find and replace, pinned tabs,
  Save As and a Markdown source/preview toggle.
- **Safe saves** — atomic writes, preserved LF/CRLF line endings, external change
  detection and crash recovery for unsaved work.
- **Git** — status, staging, commits, branches, stash, push/pull, a commit graph and
  full-file diffs, using the Git already installed on your system.
- **Terminals** — multiple on-demand terminal sessions per project that keep running
  while you switch projects.
- **Plugins** — install local plugins with permission review. See the
  [Plugin API 2 guide](docs/plugin-api-v2.md) and the
  [examples](examples/plugins).

pude deliberately leaves out project-wide indexing, a debugger, AI services, a plugin
marketplace and automatic updates.

## Install

Download the installer for your platform from
[GitHub Releases](https://github.com/MajajaX/pude/releases/latest):

| Platform | File |
| --- | --- |
| Windows 11 x64 | `pude-windows-x64-setup.exe` |
| macOS 14+ (Apple Silicon) | `pude-macos-arm64.dmg` |

Each release includes `SHA256SUMS.txt` so you can verify your download. pude never
updates itself; to update, install the newer version. Linux builds are planned —
until then you can [build from source](#build-from-source).

## Build from source

You need [Node.js](https://nodejs.org/) 22.12+ (24 recommended) with npm 10.9+,
[Rust](https://rustup.rs/) stable, Git on your `PATH`, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/MajajaX/pude.git
cd pude
npm ci
npm run tauri:dev
```

| Command | What it does |
| --- | --- |
| `npm run tauri:dev` | Run the desktop app in development mode |
| `npm run tauri:build` | Build an installer for the current platform |
| `npm run dev` | Run the UI in a browser with an in-memory demo workspace |
| `npm run web:dev` | Run the project website |
| `npm run check` | Run tests, type checks and production builds |

See [CONTRIBUTING.md](CONTRIBUTING.md) for platform notes and the full workflow.

## Project layout

```text
apps/desktop/src/          SolidJS UI, editor and frontend logic
apps/desktop/src-tauri/    Rust backend: filesystem, Git, terminal, plugins
apps/web/                  Project website
examples/plugins/          Example plugins
docs/                      Plugin API and release guides
scripts/                   Build and release tooling
```

## Privacy and security

Your files stay where they are. Settings, sessions and recovery data are stored
locally. pude itself only goes online when you click **Check for releases** in the
About dialog; Git, terminal commands and plugins you grant network access can reach
the network on their own.

The terminal and plugins run with your user account's permissions, so install only
plugins you trust. Please report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## Contributing

Bug reports, ideas and pull requests are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before you start.

## License

pude is released under the [MIT License](LICENSE). Third-party licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
