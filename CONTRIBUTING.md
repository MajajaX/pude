# Contributing to pude

Thanks for taking the time to improve `pude`. The project is an early local-first
desktop editor with a Vite/SolidJS frontend and a Tauri/Rust native bridge. Small,
focused changes are easiest to review and to verify on all supported platforms.

Before starting, check the existing issues and the [README](README.md). Please use
the private process in [SECURITY.md](SECURITY.md) for vulnerabilities; do not put
security-sensitive details in a public issue or pull request.

pude is released under the [MIT License](LICENSE). By contributing, you agree that
your contributions are licensed under the same terms. Third-party dependencies and
asset provenance are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development prerequisites

You need:

- Git, including a working `git` executable on `PATH`. The desktop app invokes Git
  for repository operations.
- Node.js from one of the repository's supported engine lines (`22.12+`, `24+`, or
  `26+`) and npm `10.9+`. Node.js 24.x is the recommended development baseline.
- Rust through `rustup`, which installs the version pinned in `rust-toolchain.toml`
  (with Clippy and rustfmt) on first use. The native app uses Tauri 2.
- The platform prerequisites listed in the
  [Tauri documentation](https://v2.tauri.app/start/prerequisites/).

Pull requests run CI on macOS, Windows and Linux, but run the checks locally before
pushing changes.
The following operating systems describe the development
verification baseline and do not promise support for every OS release, distribution,
or CPU architecture.

| Platform | Development target | Native development notes |
| --- | --- | --- |
| macOS | macOS 14+ arm64 | Install Xcode Command Line Tools and use the system WebKit runtime. |
| Windows | Windows 11 x64 | Install the MSVC C++ build tools and WebView2. |
| Linux | Local source checks | Install the GTK/WebKit and build packages from the Tauri prerequisites. |
| Browser shell | All developer machines | `npm run dev` exercises the desktop frontend fallback without native filesystem, Git, terminal, or plugin bridges. |

When native behavior differs by platform, state the OS version and CPU architecture
in the pull request and test report. A successful browser-shell build is not proof
that native dialogs, filesystem watching, Git, PTY, or packaging work on every OS.
Release targets are Windows 11 x64 and macOS 14+ arm64. Linux source checks do not
imply a Linux release commitment; Linux releases are planned, and mobile is outside
scope.

Linux terminal cleanup requires kernel 5.1 or newer, permitted `pidfd_send_signal`,
and a mounted, listable `/proc` with readable processes in the terminal's session.
It stops the shell and its job-control groups without signaling reused numeric PIDs;
deliberately daemonized processes that leave the session are outside this guarantee.
Linux native regression tests also require `python3` for a threaded-process fixture.
Linux file deletion uses GIO's recoverable system trash and reports an error when
trashing is unsupported; it never falls back to permanent deletion.

## Set up a checkout

Clone the repository, enter it, and install the exact dependency tree from the
lockfile:

```bash
git clone https://github.com/MajajaX/pude.git
cd pude
npm ci
```

Use a feature branch when you do not have direct push access. Keep unrelated local
changes out of the branch, and update `package-lock.json` only when the dependency
change is intentional. Before adding or updating a dependency, check the latest stable
version, confirm compatibility with the affected workspaces, and include the lockfile update
in the same pull request.

## Common commands

Run these from the repository root:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the desktop frontend browser shell on port 5173. |
| `npm run tauri:dev` | Run the native Tauri desktop application. |
| `npm run web:dev` | Start the public website on port 5174. |
| `npm test` | Run the desktop Vitest suite. |
| `npm run check` | Run desktop tests, desktop production build, web type checks, and web production build. |
| `npm run build` | Build the desktop frontend. |
| `npm run web:build` | Build the website. |
| `npm run tauri:build` | Build native Tauri bundles for the current platform. |
| `node scripts/run-rust-tests.mjs` | Run the Rust test suite exactly as CI does: each test in its own process, with `Cargo.lock` unchanged. Plain `cargo test` shares one process and can disagree on process-group tests. |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all` | Format Rust sources after Rust changes. |
| `cargo clippy --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings` | Run the Rust lints CI enforces. |
| `npm run test:e2e --workspace @pude/desktop` | Run the browser smoke tests against the in-memory demo. |

For a normal code change, run at least `npm run check` and the Rust test command.
Run `npm run tauri:dev` for changes that touch the native bridge, filesystem
watching, Git, the PTY terminal, plugin installation, dialogs, or window behavior.
Use the native command on each platform affected by the change when possible.

For documentation-only changes, check local links, anchors, obsolete references, and
`git diff --check`; a full application rebuild is unnecessary unless an executable
example or behavior claim needs verification. Keep reusable test fixtures in Git.
Generated schemas, permissions, logs, raw measurement reports, and QA bundles are
local outputs and are ignored.

The first Rust build may download crates. `--locked` asks Cargo to use the committed
lockfile and fail if dependency resolution would change it.

## Code and documentation style

Follow the surrounding code rather than introducing a new framework or abstraction:

- Keep TypeScript and SolidJS logic explicit, typed, and close to the component or
  library responsibility it serves. Preserve the browser fallback when changing a
  native bridge call.
- Keep Rust functions and modules small, return actionable errors, and preserve the
  existing platform-specific branches. Format Rust with `cargo fmt` before review.
- Prefer the smallest clear implementation over speculative infrastructure. Avoid
  changing unrelated UI, copy, generated schemas, or lockfile entries.
- Keep user-visible behavior and security boundaries documented when a change
  affects plugins, terminal commands, Git operations, filesystem access, recovery,
  or persisted settings.
- Use Markdown headings and fenced commands consistently. Screenshots and logs in
  issues and pull requests must be free of secrets and private source.

## Issues and pull requests

Every feature or user-visible behavior change must update its documentation in the
same pull request. Start with [the product specification](docs/product-spec.md) and
[CHANGELOG.md](CHANGELOG.md), then update the README and the English and Traditional
Chinese website and user guides (`apps/web/src/i18n.ts`, `i18n-docs.ts`). Document
the actual entry points, shortcuts, settings, limits, permissions, persistence and
platform differences. Refresh screenshots and SEO metadata when they are affected.
List the updated surfaces in the PR; explain any surface that does not need a change.
Preserve the version and date of historical benchmark measurements.

Run `npm run check` after website changes; review both languages and the relevant
desktop/mobile layouts. Before a release, use the documentation checklist in
[docs/releasing.md](docs/releasing.md). Documentation must describe implemented,
verified behavior rather than a planned feature.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). How
decisions are made and who can merge is described in [GOVERNANCE.md](GOVERNANCE.md).

Use the issue templates for reproducible bugs and feature requests. A useful bug
report includes the app version or commit, OS and architecture, whether it occurred
in the browser shell or native app, exact reproduction steps, expected behavior,
actual behavior, and a short redacted log.

For a pull request:

1. Explain the user-visible problem and the resulting behavior.
2. Keep the diff focused and call out platform-specific or data-safety effects.
3. List the commands you ran and identify any platform you could not test.
4. Update relevant documentation and templates when behavior or support boundaries
   change.
5. Remove secrets, private source, recovery snapshots, generated credentials, and
   unrelated formatting changes from the diff.

Changes to release packaging, update feeds, signing, or notarization need a
maintainer-owned release plan. The maintainer release steps are in
[docs/releasing.md](docs/releasing.md).
