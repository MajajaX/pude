# Governance

pude is a small project maintained by [@MajajaX](https://github.com/MajajaX). This
page says who decides what, so contributors know what to expect.

## Roles

- **Maintainer**: can merge pull requests, publish releases and manage repository
  settings. The current maintainer is @MajajaX.
- **Contributor**: anyone who opens an issue, a discussion or a pull request.

Contributors who have sent several good changes and show care for users' data may be
invited to become maintainers. A maintainer can step down at any time, and access is
removed after a long period of inactivity.

## How decisions are made

- Bug fixes and small improvements are merged once checks pass and a maintainer
  approves them.
- Larger features, new permissions, and changes to plugin, terminal, Git, filesystem
  or recovery behavior need an issue first, so the design can be agreed before code is
  written. These areas affect users' files, so the maintainer may decline a change that
  widens a trust boundary described in [SECURITY.md](SECURITY.md).
- When maintainers disagree, the project owner decides.

## Merging

- `main` is protected: force pushes and deletion are blocked, and pull requests must
  pass the CI checks (`Web and tooling`, `Rust (macos-latest)`, `Rust (windows-latest)`).
- Changes to signing, updates, release workflows and permissions are listed in
  [.github/CODEOWNERS](.github/CODEOWNERS) and are reviewed by the project owner.
- Dependency updates arrive through Dependabot and follow the same rules as any other
  pull request.

## Releases

Only maintainers publish releases, following [docs/releasing.md](docs/releasing.md).
The update signing key and the Apple certificate are held by the project owner and are
never shared with contributors or committed to the repository.

## Response expectations

Maintainers work on the project in their spare time. Issues and pull requests are
read on a best-effort basis, with no guaranteed response time. Security reports follow
[SECURITY.md](SECURITY.md) instead.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
