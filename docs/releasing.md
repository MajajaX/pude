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
notarized macOS DMG and the Windows installer in parallel, then runs the publish job:

1. It writes `latest.json` and checks every update package against
   `plugins.updater.pubkey` in `tauri.conf.json` (see [Update signatures](#update-signatures)).
   Nothing is uploaded if a signature does not verify.
2. It writes `SHA256SUMS.txt`, covering every other release file: both installers,
   the update package, both `.sig` files, `latest.json` and the three legal files.
3. It creates the release as a **draft** with the changelog section as notes. A
   draft is not served at `releases/latest`, so installed copies cannot see it yet.
4. It verifies the draft: the exact asset set, repository and tag, and that
   `SHA256SUMS.txt` lists every download.
5. It publishes the draft (`gh release edit --draft=false --latest`) and verifies
   the public release again. If that last check fails, the release is turned back
   into a draft so `latest.json` stops being served.

Continue with step 5 (website downloads) when it finishes. If the job fails before
publication, a draft release may remain; delete it from the Releases page before
re-running the workflow.

### Update signatures

`node scripts/verify-update-signatures.mjs release` reads `latest.json` and, for each
platform, checks the minisign signature that Tauri produced with the release key
(prehashed Ed25519, key id, and the signature over the trusted comment). It also
checks that the signature in `latest.json` equals the package's `.sig` file and that
the version Tauri signed matches the manifest version. Both platforms must be present;
`write-update-manifest.mjs` and the verifier take `--allow-partial` to publish a
single-platform manifest on purpose.

Publication downloads only the `release-macos` and `release-windows` build
artifacts. CI diagnostics remain attached to the Actions run, including after a
failed job is rerun; they must not be uploaded as release assets.

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

Before versioning, review every user-visible change since the previous release:

- Update [the product specification](product-spec.md) and the matching changelog
  entry with implemented behavior and any limitations.
- Synchronize the README, English and Traditional Chinese homepage and user guides,
  including entry points, shortcuts, settings, permissions, persistence and OS notes.
- Check affected screenshots, SEO/social metadata and asset provenance. Preserve
  the original version/date of historical benchmark measurements.
- Record any unaffected documentation surface and its reason in the PR. Review
  both website languages and relevant desktop/mobile layouts; run `npm run check`.
- Confirm the release commit's CI and security checks pass on macOS, Windows and
  Linux before tagging. Do not bypass a failed check to publish.

```bash
npm run release:version:sync -- 0.1.0
npm ci
npm run check
npm run release:tooling:self-test
node scripts/run-rust-tests.mjs
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
update manifest from the changelog notes, verify the update signatures, and create one
`SHA256SUMS.txt` covering every other file (it must come after `latest.json`, which it
lists):

```bash
node scripts/write-update-manifest.mjs release-files v0.1.0 release-notes.md
node scripts/verify-update-signatures.mjs release-files
cd release-files
node ../scripts/write-checksums.mjs create SHA256SUMS.txt \
  pude-windows-x64-setup.exe pude-windows-x64-setup.exe.sig \
  pude-macos-arm64.dmg pude-macos-arm64.app.tar.gz pude-macos-arm64.app.tar.gz.sig \
  latest.json LICENSE THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.md
```

Create the release as a draft with these ten files (both installers,
`pude-macos-arm64.app.tar.gz`, the two `.sig` files, `latest.json`, `SHA256SUMS.txt`
and the three legal files), verify the draft, and only then publish it as the latest
release (not a prerelease):

```bash
gh release create v0.1.0 release-files/* --draft --title 'pude v0.1.0' --notes-file release-notes.md --verify-tag
npm run release:verify-url -- 'https://github.com/MajajaX/pude/releases/tag/v0.1.0' --draft
gh release edit v0.1.0 --draft=false --latest
npm run release:verify-url -- 'https://github.com/MajajaX/pude/releases/tag/v0.1.0'
```

Each check is strict by default: a draft is accepted only with `--draft`, and a
published release only without it. The draft check lists releases through the API
because the tag endpoint never returns drafts, then compares the draft's asset records
and `SHA256SUMS.txt` against the required files. If the final check fails, run
`gh release edit v0.1.0 --draft=true` so the updater stops serving `latest.json`.
Add `--platform macos` or `--platform windows` when only one installer is published
(and `--allow-partial` to the manifest commands).

## 5. Enable website downloads

The website at https://pude.dev is deployed to Cloudflare Workers from
[wrangler.jsonc](../wrangler.jsonc). It shows its download buttons, and the
"Published release" label next to the version, only when it is built with the tagged
release URL of the version in `package.json`. `releases/latest` is deliberately not
accepted: it can still serve an older release, so it cannot show that this version is
out. A build without the variable shows the version as a release candidate with
downloads disabled, and `npm run web:build` fails when `VITE_RELEASE_URL` is set to
anything other than the tagged URL of the current version.

After the release is published and verified, set this build variable on the `pude-web`
Worker in the Cloudflare dashboard (changing the version on every release) and
redeploy:

```text
VITE_RELEASE_URL=https://github.com/MajajaX/pude/releases/tag/v0.1.0
```

To build and deploy from a local checkout instead (`npx` runs the exact `wrangler`
version pinned in the root `package.json` after `npm ci`):

```bash
VITE_RELEASE_URL='https://github.com/MajajaX/pude/releases/tag/v0.1.0' npm run web:build
npx wrangler deploy
```

`apps/web/public/_headers` sets the Content-Security-Policy, HSTS and cache headers.
The CSP allows exactly one inline script, the Solid hydration bootstrap, by its
SHA-256 hash; `npm run web:build` fails if the built pages contain an inline script
whose hash is missing from the policy, so update the hash in `_headers` when it
reports one (for example after upgrading `solid-js`).

The English pages use `/` and `/docs`; Traditional Chinese uses `/zh/` and
`/zh/docs`. The website build generates canonical URLs, language alternates and
the sitemap from `apps/web/src/site.ts`. Keep `apps/web/public/_redirects` when
deploying: it permanently redirects the old `index.zh-Hant` and `docs.zh-Hant`
URLs, including their `.html` variants, to the new pages. Vite development and
preview servers use the same redirect rules.
