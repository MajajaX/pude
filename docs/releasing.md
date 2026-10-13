# Releasing pude

This guide is for maintainers. Releases are built locally; the repository has no
release workflow yet.

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

The DMG, legal files and `SHA256SUMS-macos.txt` are written to `dist/release-macos/`.

### Windows 11 x64

On a Windows machine, build the NSIS installer and collect it with the legal files:

```powershell
npm run tauri:build -- --bundles nsis
node scripts/collect-release-bundle.mjs windows dist/release-windows --bundle-root apps/desktop/src-tauri/target
```

Signing is optional for Windows. A signed installer can be checked with
`node scripts/verify-release-artifact.mjs windows dist/release-windows/pude-windows-x64-setup.exe`.

## 4. Publish

Create one `SHA256SUMS.txt` covering both installers and the three legal files:

```bash
node scripts/write-checksums.mjs create SHA256SUMS.txt \
  pude-windows-x64-setup.exe pude-macos-arm64.dmg \
  LICENSE THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.md
```

Upload these six files to a GitHub Release for the tag and publish it (not as a
draft or prerelease). Then verify it:

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
