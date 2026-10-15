# Releasing pude

This guide is for maintainers. Pushing a `v*` tag runs
[.github/workflows/release.yml](../.github/workflows/release.yml), which builds both
installers on GitHub-hosted runners and publishes the GitHub Release. Sections 3 and
4 describe the same steps by hand, for when the workflow cannot be used.

## Release with GitHub Actions

Add these repository secrets once (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | The `Developer ID Application` certificate exported as `.p12`, base64 encoded: `base64 -i certificate.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | The password chosen when exporting the `.p12` |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |
| `APPLE_API_KEY` | App Store Connect API key ID |
| `APPLE_API_KEY_CONTENT` | The full text of the `AuthKey_<ID>.p8` file |
| `TAURI_SIGNING_PRIVATE_KEY` | The full text of the updater signing key (see [Updater signing key](#updater-signing-key)) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password of the updater signing key |

Releases are stable-only: the workflow rejects a tag or workspace version with a prerelease
suffix (such as `-rc.1`) before building anything. After step 1 and step 2 below (version
sync, changelog, tag), push the tag:

```bash
git push origin main v0.1.0
```

The workflow checks the tag, runs the same jobs as CI (`npm run check`, the release
tooling self-test, the browser smoke test, Rust formatting, lints and tests on all three
platforms), builds the signed and
notarized macOS DMG and the Windows installer in parallel, writes `latest.json` and
`SHA256SUMS.txt`, publishes the release with the changelog section as notes, and
verifies it. Continue with step 5 when it finishes.

## Updater signing key

Installed copies of pude check `releases/latest/download/latest.json` on startup and
install updates only when the package signature matches the public key in
`tauri.conf.json` (`plugins.updater.pubkey`). The private key signs every release:

- Locally it lives in `~/.config/pude/updater.key`, loaded through
  `~/.config/pude/release.env` (`TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
- Upload it to GitHub with `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.config/pude/updater.key`.
- Back it up outside the repository. If it is lost, installed copies cannot verify a
  new key and users must install a new build by hand. Never commit it.

Update packages are produced only with `--config src-tauri/tauri.release.conf.json`,
which turns on `createUpdaterArtifacts`; ordinary `tauri:build` runs do not need the key.

## 1. Prepare the version

```bash
npm run release:version:sync -- 0.1.0
npm ci
npm run check
npm run release:tooling:self-test
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

`release:version:sync` updates every npm manifest, `package-lock.json`, `Cargo.toml`,
`Cargo.lock` and `tauri.conf.json`. It never commits or tags.

Move the `Unreleased` entries in [CHANGELOG.md](../CHANGELOG.md) under the new
version. `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES.md` must each contain
exactly one `<!-- release-readiness: approved -->` line; review both after any
dependency or asset change.

## 2. Tag

Commit the release changes, then create a tag that matches the workspace version and
run the release check on that clean checkout:

```bash
git tag v0.1.0
node scripts/release-version.mjs release-check v0.1.0
```

The check fails when the tag does not match the version, does not point to `HEAD`,
or the working tree is dirty.

## 3. Build the installers

### macOS (Apple Silicon)

Requires a `Developer ID Application` certificate in the login keychain and
notarization credentials in the environment (or in `~/.config/pude/release.env`).
See the header of [scripts/release-macos.sh](../scripts/release-macos.sh).

```bash
npm run release:macos
```

The DMG, the update package (`.app.tar.gz` and `.sig`), legal files and
`SHA256SUMS-macos.txt` are written to `dist/release-macos/`. The updater signing key
variables must be set as well.

### Windows 11 x64

On a Windows machine with `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` set, build the NSIS installer (which is also the
update package) and collect it with its signature and the legal files:

```powershell
npm run tauri:build -- --bundles nsis --config src-tauri/tauri.release.conf.json
node scripts/collect-release-bundle.mjs windows dist/release-windows --bundle-root apps/desktop/src-tauri/target
```

Signing is optional for Windows. A signed installer can be checked with
`node scripts/verify-release-artifact.mjs windows dist/release-windows/pude-windows-x64-setup.exe`.
The check installs the app, so it only runs on an ephemeral GitHub Actions Windows runner
(`GITHUB_ACTIONS` and `RUNNER_TEMP` set) with `WINDOWS_CERTIFICATE_THUMBPRINT` set to the
signing certificate's thumbprint. It expects the version in `tauri.conf.json`.

## 4. Publish

Put both platforms' files and the three legal files in one directory, write the
update manifest from the changelog notes, and create one `SHA256SUMS.txt` covering
both installers and the legal files:

```bash
node scripts/write-update-manifest.mjs release-files v0.1.0 release-notes.md
cd release-files
node ../scripts/write-checksums.mjs create SHA256SUMS.txt \
  pude-windows-x64-setup.exe pude-macos-arm64.dmg \
  LICENSE THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.md
```

Upload these ten files to a GitHub Release for the tag and publish it (not as a
draft or prerelease): both installers, `pude-macos-arm64.app.tar.gz`, the two `.sig`
files, `latest.json`, `SHA256SUMS.txt` and the three legal files. Then verify it:

```bash
npm run release:verify-url -- 'https://github.com/MajajaX/pude/releases/latest'
```

Add `--platform macos` or `--platform windows` when only one installer is published.

## 5. Enable website downloads

The website at https://pude.dev is deployed to Cloudflare Workers from
[wrangler.jsonc](../wrangler.jsonc). It shows its download button only when it is
built with a verified release URL. In the Cloudflare dashboard, add this build
variable to the `pude-web` Worker and redeploy:

```text
VITE_RELEASE_URL=https://github.com/MajajaX/pude/releases/latest
```

To build and deploy from a local checkout instead:

```bash
VITE_RELEASE_URL='https://github.com/MajajaX/pude/releases/latest' npm run web:build
npx wrangler deploy
```
