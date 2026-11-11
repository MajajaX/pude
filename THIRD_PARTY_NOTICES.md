# Third-party notices

<!-- release-readiness: approved -->

This file records `pude`'s third-party dependencies, asset provenance and license status. The
full license text of every package is collected in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md) and ships with the desktop bundle;
this file lists the direct dependencies and any source or rights still awaiting confirmation. An entry marked "to be confirmed" means this file is not yet a releasable notice.

## Scope and evidence

- JavaScript workspaces and direct dependency versions come from [`apps/desktop/package.json`](./apps/desktop/package.json) and [`apps/web/package.json`](./apps/web/package.json); resolved versions, integrity and the `license` field come from [`package-lock.json`](./package-lock.json) (lockfile v3).
- Rust direct dependencies and version requirements come from [`apps/desktop/src-tauri/Cargo.toml`](./apps/desktop/src-tauri/Cargo.toml); resolved versions and checksums come from [`apps/desktop/src-tauri/Cargo.lock`](./apps/desktop/src-tauri/Cargo.lock). Cargo.lock does not record licenses, so each Rust license identifier was checked against the published package metadata of the same locked version; on 2026-09-27 the exact `.crate` archives, checksums and named license files of the target-platform closure were checked.
- The 2026-09-27 review completed the version and license identifier of the then 32 npm and 12 Cargo direct dependencies; the full lockfile closure and original license file inventory are in the dated snapshots below.
- 2026-09-28 LW-05 re-review after dependency upgrades: direct dependency versions follow `package-lock.json` and `Cargo.lock` (see the tables below); [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md) was fully re-verified for the upgraded Windows and macOS runtime closures (47 npm runtime packages with 49 license files; 300 macOS arm64 and 305 Windows x64 runtime crates with 600 named license files across both platforms, and 18 or more crates completed from their exact upstream sources). Every archive checksum or SRI and every license text hash matched.
- The project is MIT licensed; the root [`LICENSE`](./LICENSE), the root, desktop and web npm metadata and the Cargo package metadata say MIT. This licenses the project itself only and does not extend to assets whose source, author or distribution rights have not been checked.

- 2026-10-15 v0.1.2: checked the direct dependency versions after this update and added the exact archives, lock digests and license text hashes of 30 package versions in the current macOS and Windows runtime closures that were not listed yet; earlier versions remain in the full license inventory.

- 2026-10-19 v0.1.3: Tauri updated to 2.12.1 and the updater to 2.14.0; the exact archive checksums and license files of the six updated packages were checked and recorded in the full inventory. Windows uses only the existing raw NSIS EXE update format with ZIP support turned off; macOS and Linux keep tar.gz. The security check resolves the actual features and dependencies per platform and adds no advisory ignore rules. The website OG image and the GitHub social preview use the same 1280x640 brand image; its generation prompt is in [`docs/github-social-preview.prompt.txt`](./docs/github-social-preview.prompt.txt), and its file hash and distribution scope are in the table below.

- 2026-10-22: added the interface fonts `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` (both 5.3.0, OFL-1.1). The font files ship inside the desktop bundle and are never loaded from the network. Both npm archives match their `package-lock.json` SRI, and their license texts (including the font copyright notices and the full SIL Open Font License 1.1) are in the full license inventory.

- 2026-10-28 v0.1.7: added the direct dependency `@codemirror/autocomplete` 6.20.4 (closes brackets and quotes); `@codemirror/view` updated to 6.43.15, Tauri to 2.12.4 and libc to 0.2.191. The four archives match their `package-lock.json` SRI or `Cargo.lock` SHA-256, and their license files are identical to the previous version, as recorded in the full inventory.

- 2026-11-05 v0.1.8: added the direct dependency `@xterm/addon-search` 0.16.0 (MIT, terminal search); `tauri-plugin-single-instance` updated to 2.5.5 and `tauri-plugin-updater` to 2.14.1, and the build tools `@tauri-apps/cli` to 2.12.4 and `vite` to 8.3.5. The new and updated runtime archives match their `package-lock.json` SRI or `Cargo.lock` SHA-256; the license files of both Tauri plugins are byte-for-byte identical to the previous version, and the LICENSE of `@xterm/addon-search` is in the full inventory.

- 2026-11-11 v0.1.9: no new direct dependencies. Runtime dependencies `solid-js` updated to 1.9.18, `notify` to 8.2.1, `tokio` to 1.54.1 and `uuid` to 1.29.0; the build and test tools `tauri-build` to 2.7.4, `vite-plugin-solid` to 2.11.15, `vitest` to 5.1.0, `fake-indexeddb` to 6.2.7 and `@types/node` to 26.6.6. `npm ci` and Cargo verified the installs against the `package-lock.json` SRI and `Cargo.lock` SHA-256; every SPDX license is unchanged and the license files are byte-for-byte identical to the previous version, except that the LICENSE.md of `vitest` writes the repository URL of one bundled dependency differently. `vite-plugin-solid` ships no license file and is MIT according to its package.json.

## JavaScript and npm

### Desktop runtime

The versions and license identifiers below come from the matching `packages["node_modules/…"]` entries of `package-lock.json`; the upstream links are the repositories recorded in each package's metadata.

| Package | Locked version | License identifier | Upstream source | Used by |
| --- | ---: | --- | --- | --- |
| `@codemirror/autocomplete` | 6.20.4 | MIT | [repository](https://code.haverbeke.berlin/codemirror/autocomplete) | desktop runtime |
| `@codemirror/commands` | 6.11.1 | MIT | [repository](https://code.haverbeke.berlin/codemirror/commands) | desktop runtime |
| `@codemirror/lang-cpp` | 6.0.3 | MIT | [repository](https://github.com/codemirror/lang-cpp) | desktop runtime |
| `@codemirror/lang-css` | 6.3.1 | MIT | [repository](https://github.com/codemirror/lang-css) | desktop runtime |
| `@codemirror/lang-go` | 6.0.1 | MIT | [repository](https://github.com/codemirror/lang-go) | desktop runtime |
| `@codemirror/lang-html` | 6.4.12 | MIT | [repository](https://code.haverbeke.berlin/codemirror/lang-html) | desktop runtime |
| `@codemirror/lang-java` | 6.0.2 | MIT | [repository](https://github.com/codemirror/lang-java) | desktop runtime |
| `@codemirror/lang-javascript` | 6.2.5 | MIT | [repository](https://github.com/codemirror/lang-javascript) | desktop runtime |
| `@codemirror/lang-json` | 6.0.2 | MIT | [repository](https://github.com/codemirror/lang-json) | desktop runtime |
| `@codemirror/legacy-modes` | 6.5.5 | MIT | [repository](https://code.haverbeke.berlin/codemirror/legacy-modes) | desktop runtime |
| `@codemirror/lang-markdown` | 6.5.2 | MIT | [repository](https://code.haverbeke.berlin/codemirror/lang-markdown) | desktop runtime |
| `@codemirror/lang-python` | 6.2.1 | MIT | [repository](https://github.com/codemirror/lang-python) | desktop runtime |
| `@codemirror/lang-rust` | 6.0.2 | MIT | [repository](https://github.com/codemirror/lang-rust) | desktop runtime |
| `@codemirror/lang-sql` | 6.10.0 | MIT | [repository](https://github.com/codemirror/lang-sql) | desktop runtime |
| `@codemirror/lang-yaml` | 6.1.3 | MIT | [repository](https://github.com/codemirror/lang-yaml) | desktop runtime |
| `@codemirror/language` | 6.13.1 | MIT | [repository](https://code.haverbeke.berlin/codemirror/language) | desktop runtime |
| `@codemirror/search` | 6.7.2 | MIT | [repository](https://code.haverbeke.berlin/codemirror/search) | desktop runtime |
| `@codemirror/state` | 6.7.6 | MIT | [repository](https://code.haverbeke.berlin/codemirror/state) | desktop runtime |
| `@codemirror/theme-one-dark` | 6.1.3 | MIT | [repository](https://github.com/codemirror/theme-one-dark) | desktop runtime |
| `@codemirror/view` | 6.43.15 | MIT | [repository](https://code.haverbeke.berlin/codemirror/view) | desktop runtime |
| `@fontsource-variable/inter` | 5.3.0 | OFL-1.1 | [repository](https://github.com/fontsource/font-files) | desktop runtime (bundled UI font) |
| `@fontsource-variable/jetbrains-mono` | 5.3.0 | OFL-1.1 | [repository](https://github.com/fontsource/font-files) | desktop runtime (bundled code font) |
| `@tauri-apps/api` | 2.12.4 | Apache-2.0 OR MIT | [repository](https://github.com/tauri-apps/tauri) | desktop runtime |
| `@xterm/addon-fit` | 0.11.0 | MIT | [repository](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit) | desktop runtime |
| `@xterm/addon-search` | 0.16.0 | MIT | [repository](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-search) | desktop runtime |
| `@xterm/xterm` | 6.0.0 | MIT | [repository](https://github.com/xtermjs/xterm.js) | desktop runtime |
| `codemirror` | 6.0.2 | MIT | [repository](https://github.com/codemirror/basic-setup) | desktop runtime |
| `solid-js` | 1.9.19 | MIT | [repository](https://github.com/solidjs/solid) | desktop and web runtime |

### Build, type and test tools

Not all of these packages reach the runtime bundle, but they take part in building, type-checking and testing the released desktop app or website, so a version change still needs its notice checked again.

| Package | Locked version | License identifier | Upstream source | Used by |
| --- | ---: | --- | --- | --- |
| `@tauri-apps/cli` | 2.12.4 | Apache-2.0 OR MIT | [repository](https://github.com/tauri-apps/tauri) | desktop build |
| `@xterm/headless` | 6.0.0 | MIT | [repository](https://github.com/xtermjs/xterm.js) | desktop test |
| `fake-indexeddb` | 6.2.8 | Apache-2.0 | [repository](https://github.com/dumbmatter/fakeIndexedDB) | desktop test |
| `@types/node` | 26.6.6 | MIT | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped) | desktop and web typecheck |
| `typescript` | 7.0.2 | Apache-2.0 | [repository](https://github.com/microsoft/TypeScript) | desktop and web build |
| `vite` | 8.3.8 | MIT | [repository](https://github.com/vitejs/vite) | desktop and web build |
| `vite-plugin-solid` | 2.11.16 | MIT | [repository](https://github.com/solidjs/vite-plugin-solid) | desktop and web build |
| `vitest` | 5.1.0 | MIT | [repository](https://github.com/vitest-dev/vitest) | desktop test |
| `@playwright/test` | 1.65.0 | Apache-2.0 | [repository](https://github.com/microsoft/playwright) | desktop end-to-end test |
| `@biomejs/biome` | 2.6.6 | MIT OR Apache-2.0 | [repository](https://github.com/biomejs/biome) | lint and format |
| `wrangler` | 4.160.0 | MIT OR Apache-2.0 | [repository](https://github.com/cloudflare/workers-sdk) | website deploy |

### npm review limits

The `license` field of `package-lock.json` is only a package metadata identifier; it is not the license text and does not guarantee that every notice shipped with the package is covered. On 2026-09-27 lockfile v3 had 221 external package entries, all with `license`, `resolved` and `integrity`, and every `resolved` URL pointed to `registry.npmjs.org`. The 85 tarballs without a local license file were fetched from their exact `resolved` URLs: the integrity reported by `npm pack` matched the lockfile SRI for 85 of 85, and the license in each tarball's metadata matched the lockfile for 85 of 85. Only 19 tarballs contain a named `LICENSE`, `LICENCE`, `COPYING`, `NOTICE`, `UNLICENSE` or `COPYRIGHT` file; the other 66 have none. These 85 include cross-platform optional packages that are not installed and build or test tools that are not distributed with the installer, so the 66 archives without such a file do not mean a shipped runtime package lacks its license text. The 47-package desktop runtime closures of macOS arm64 and Windows x64 were each checked against the exact archive, the SPDX identifier and 48 original license or notice files; the output and source hashes are in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).

## Rust and Cargo

The license identifiers below come from the published `Cargo.toml` metadata of the same crate version; versions and checksums follow [`Cargo.lock`](./apps/desktop/src-tauri/Cargo.lock). The full license texts ship with the bundle in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).

| Crate | Locked version | License identifier | Upstream source | Used by |
| --- | ---: | --- | --- | --- |
| `tauri` | 2.12.4 | Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/tauri/2.12.4) · [repository](https://github.com/tauri-apps/tauri) | runtime |
| `tauri-plugin-single-instance` | 2.5.5 | Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/tauri-plugin-single-instance/2.5.5) · [repository](https://github.com/tauri-apps/plugins-workspace) | runtime (ST-07 single instance) |
| `tauri-plugin-updater` | 2.14.1 | Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/tauri-plugin-updater/2.14.1) · [repository](https://github.com/tauri-apps/plugins-workspace) | runtime |
| `tauri-build` | 2.7.4 | Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/tauri-build/2.7.4) · [repository](https://github.com/tauri-apps/tauri) | build dependency |
| `cap-std` | 4.0.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/cap-std/4.0.3) · [repository](https://github.com/bytecodealliance/cap-std) | runtime |
| `libc` | 0.2.191 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/libc/0.2.191) · [repository](https://github.com/rust-lang/libc) | runtime |
| `memchr` | 2.8.3 | Unlicense OR MIT | [crates.io](https://crates.io/crates/memchr/2.8.3) · [repository](https://github.com/BurntSushi/memchr) | runtime |
| `notify` | 8.2.1 | CC0-1.0 | [crates.io](https://crates.io/crates/notify/8.2.1) · [repository](https://github.com/notify-rs/notify) | runtime |
| `portable-pty` | 0.9.0 | MIT | [crates.io](https://crates.io/crates/portable-pty/0.9.0) · [repository](https://github.com/wezterm/wezterm) | runtime |
| `reqwest` | 0.13.5 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/reqwest/0.13.5) · [repository](https://github.com/seanmonstar/reqwest) | runtime |
| `rfd` | 0.17.2 | MIT | [crates.io](https://crates.io/crates/rfd/0.17.2) · [repository](https://github.com/PolyMeilex/rfd) | runtime |
| `rustls` | 0.23.46 | Apache-2.0 OR ISC OR MIT | [crates.io](https://crates.io/crates/rustls/0.23.46) · [repository](https://github.com/rustls/rustls) | runtime |
| `serde` | 1.0.229 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/serde/1.0.229) · [repository](https://github.com/serde-rs/serde) | runtime |
| `serde_json` | 1.0.154 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/serde_json/1.0.154) · [repository](https://github.com/serde-rs/json) | runtime |
| `tokio` | 1.54.1 | MIT | [crates.io](https://crates.io/crates/tokio/1.54.1) · [repository](https://github.com/tokio-rs/tokio) | runtime |
| `uuid` | 1.29.0 | Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/uuid/1.29.0) · [repository](https://github.com/uuid-rs/uuid) | runtime |
| `windows` | 0.62.2 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/windows/0.62.2) · [repository](https://github.com/microsoft/windows-rs) | Windows runtime (taskbar Jump List) |

### Cargo review limits and the 2026-09-27 snapshot

2026-09-29 ST-07 incremental review: the newly added `tauri-plugin-single-instance@2.5.0` and the `tracing-attributes@0.1.31` it enables were checked archive by archive against the Cargo.lock checksums, and their four named license files are included in full in `THIRD_PARTY_LICENSES.md`. The normal runtime closure then had 269 macOS arm64 and 273 Windows x64 crates (excluding pude); license texts of earlier versions are kept.

The package blocks of `Cargo.lock` include the Tauri runtime, WebView, platform integration, system bindings and other transitive dependencies; the lockfile has no license field, so licenses cannot be inferred from package names. Running `cargo metadata --locked --filter-platform` for the locked `aarch64-apple-darwin` and `x86_64-pc-windows-msvc` targets gives a normal dependency graph of 307 macOS and 312 Windows crates, or 328 and 335 with build dependencies. Every `.crate` archive SHA-256 matched its Cargo.lock checksum (macOS normal and build 328/328; Windows 335/335), and every package's published `Cargo.toml` has `license` or `license-file` metadata. A recursive check of the shipped normal runtime source trees found 19 macOS and 11 Windows crates, 22 distinct crates in all, without a named license file in the `.crate` archive; for these 22 the original license text or the package's license choice was checked at the upstream commit pinned by `.cargo_vcs_info.json`, and the source and hash are listed in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md). A recursive inventory of 340 runtime Cargo crates found 606 named license or notice files, and the full texts of the 307 macOS and 312 Windows normal runtime crates are included. Only the normal runtime closure actually distributed with the app is part of this F01 release gate; build, test and Android-only packages are inventoried separately and do not block the app.

## Release maintenance rules

1. Update the manifest first, then update [`package-lock.json`](./package-lock.json) or [`Cargo.lock`](./apps/desktop/src-tauri/Cargo.lock) with the lockfile's reproducible command; a release commit must contain both the manifest and lockfile changes.
2. When a dependency is added, removed or changes version, check the license identifier, upstream source, license files and notices of the exact package or crate again; update this file when a license changes, for example from a single license to a dual license or another expression. `node scripts/verify-notice-versions.mjs`, part of `npm run check`, fails when a direct dependency is missing from the tables above or listed at a different version than the lockfile.
3. For every release, run one license and notice inventory over the full npm lockfile closure and the full Cargo lockfile closure. The scan must include platform-specific packages and build or test tools, not only the runtime bundle.
4. Ship the required third-party license and notice files with the release artifacts, and keep the scanned lockfiles, versions, checksums or integrity values and the date of the output. Do not replace the original license files with the identifiers in this file.
5. When upstream metadata, the repository, a license file or a notice cannot be checked from the exact source, mark the entry "to be confirmed" for the release owner to supply evidence before release; never fill in a full license text by guessing.
6. After adding to or updating this file, check that every relative link still points to an existing manifest, lockfile or asset source; when an asset is replaced, update the [asset provenance record](#asset-provenance) as well.

## Items awaiting confirmation

- The 47-package npm runtime closure and the 307 and 312 Cargo normal runtime crates of macOS arm64 and Windows x64 have had their source archives, checksums, license metadata and full license texts checked; per-file sources and content hashes are in the bundled [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md). Missing named files in other build, test or optional lockfile entries are not part of the app runtime gate.

<a id="asset-provenance"></a>

## Asset rights statement and per-file inventory

The maintainer confirms that the image assets in the table below were made by the maintainer or generated with AI, and licenses MajajaX to distribute them under the project's [`MIT LICENSE`](./LICENSE). This statement covers the files listed below. No per-item author, generation tool, external source URL or creation date was provided, so this record does not fill in or infer them.

The inventory covers 50 source icons in `apps/desktop/icon-src`, 3 image files in `apps/desktop/public`, 8 image files in `apps/web/public` and 53 files in `apps/desktop/src-tauri/icons`. PNG, WebP and JPEG dimensions come from the file headers, ICO and ICNS entries list the sizes in the container, and each SHA-256 covers the original file bytes. Android XML launcher files are listed for completeness; dimensions do not apply to them.

Files in both Vite `public` directories are copied into their frontend dist; the desktop frontend is packaged with the Tauri app. `apps/desktop/icon-src` keeps the original PNG icons, which are not distributed with the frontend; `scripts/convert-icons.py` scales the same images to 32x32 cells to produce `apps/desktop/public/icons/sprite.webp`. The sprite only changes size, layout and format, so it carries the rights statement of these 50 source icons. Tauri currently lists `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns` and `icon.ico` as bundle icon inputs. The other items in the Tauri icon folder are not listed in the current `bundle.icon` of `tauri.conf.json` and are not inputs of the current Windows or macOS bundles.

| Path | Dimensions / format | SHA-256 | Current distribution scope |
| --- | --- | --- | --- |
| `apps/desktop/icon-src/language/c.png` | 64x64 px | `c2c514deaef083b84d9326a43195814d704f52272f757f85d2904e33f141eba4` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/cpp.png` | 64x64 px | `c9f19baf104f745dc6e0e394ebd157a7fd7103efa381bdb84bffd896948749c6` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/csharp.png` | 64x64 px | `62facb1448da8ea9f24f4fe0734ab8b6608301fd3df4f1ca5ea6e4d1259e6cc8` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/css.png` | 64x64 px | `6dcb5dc21680972576d71cb3627f0d9323b94e0c6934dfb5edd6fbbb4b912e6c` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/go.png` | 64x64 px | `10739b9e3f0c5344d3803b81a4062f669a4de357bb9db9b8f5a552d39c9538ff` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/html.png` | 64x64 px | `e58b963da15e4db9394f6a6bf672b75f37d16c702c500848dbd1fd23e2238baf` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/java.png` | 64x64 px | `48a0e54869698bbcd4d5e84912ed24626358f46a1cb273efa36933082c96aa1d` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/js.png` | 64x64 px | `ae19a9541d77eb00edce6c07f6b9d5a47298bda57a925c276f458278d90975a1` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/json.png` | 64x64 px | `27b10ebf6969f0c0c9b5b1becdcf5172a21a986c23b616d515f487ea33e25b06` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/md.png` | 64x64 px | `17df7fe54ca5bc13bd0110a9156c5c07c1479450b591e6fdd6029c71de3d0112` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/py.png` | 64x64 px | `6e51e35cfdc2b308bab7086d1cab28dae3b8b668cab15c7be24a34f11c64b916` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/rs.png` | 64x64 px | `4955f5a19ce039d334833fccf3e0109adc020f6e9b94d7721344d5645619baa1` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/sh.png` | 64x64 px | `5820a1b927b5319b904bced15bb94804d0274b2fd17bf07edd03574f1ba6a4e0` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/sql.png` | 64x64 px | `a88699122db54949d82999fb659b27bef6628c400aa913b9c29bf2c90e42edae` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/toml.png` | 64x64 px | `35f4c8464beb259c9da1cc8f6098f6c84eba0f4f83ceb8848d60098201e27e94` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/ts.png` | 64x64 px | `6a5d5d184e0076805a01aca94235529df71aac9a03f1ed933c36b72873752e81` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/language/yaml.png` | 64x64 px | `5ca172cf821e699bde9c3645d403306d864d4ee7478904269c4ed5eb7f20ca7b` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/arrow-down.png` | 64x64 px | `f6ec3e9ebfab263664adacf2e4389e3eb6d8ab8e16513f43526cf78a4720ad85` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/arrow-up.png` | 64x64 px | `0c36123c320fd20434e3f736d6e768c0dbe037697cfb34a677b1bab29db5f8f3` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/check.png` | 64x64 px | `1034359f797ee2fdce73171d7e5190ef48f8596256b82f65c3a2130e9cbe54e2` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/chevron-down.png` | 64x64 px | `71991c9cd9a7a1303a04136038c21cfd501dad4dc5915de533898c69ddce18ae` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/chevron-right.png` | 64x64 px | `c351ae2f00e18a47c207cf2ced11a603ebba2f54155ab5bd54a193a3c0c4b75f` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/close.png` | 64x64 px | `edc52060c548aa55b97e6049c381a11f30392601f10ceedd957146c267bf73e7` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/command.png` | 64x64 px | `cb5fe99818a304866755469a052490081b6823db6f590a17ec23556a86d52041` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/copy.png` | 64x64 px | `40bb2d1aaed8d7903efd0bc801ace57a2d6fcd3989dd6741448b62d2b990dab1` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/external.png` | 64x64 px | `87818484545b14368369f71d616103772ee022330782abb209ded89dfa5d77cb` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/file-code.png` | 64x64 px | `80dd923847a59f7b9ab1ffa92ff5a42c60d38254a1cec651c9901eb3eff91ad1` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/file.png` | 64x64 px | `9cd4a0cc17ad3daaa387a3590ba75b88ae66459b6054b257ad7c986e81e95ada` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/folder-open.png` | 64x64 px | `35dc982c337f8e3c78339eb525fdc5c09ccfd886cc055cfdb8ae6c9a60ba7bc3` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/folder.png` | 64x64 px | `16e7537d6befdc87bd99c7a48810a1196297c51ed5e0e11ba823c524d9449da1` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/git-discard.png` | 64x64 px | `3eda1fdd6edf58cada7ce16bf352542410539c74f2ca48d869230a46b53e7763` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/git-stage.png` | 64x64 px | `fdb8a4076f8679bf4ca0ed0a4b7c0f0c94f47a22d700bb01473872140f8fa933` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/git-unstage.png` | 64x64 px | `bf3448710302c0673a5e754d96a1c0ec08aca680c3f467fb65f475f430e9e106` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/git.png` | 64x64 px | `1d3bfbd00cda8d8ff4090b811944764dd3d281200e4a954cffeefc2101f83bac` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/lock.png` | 64x64 px | `ed82a293d3e3365b1cdd49bfdcae24468a93f1b7235d0655b5de37146cfa3efe` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/moon.png` | 64x64 px | `2ef88843963c9319d71fbcf5492ea5670e590844c71d3248ef9f72fc5341e14b` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/more.png` | 64x64 px | `711591baaab7ae8ab6ac2f16aa79d4e389f3574db26e20fb8713297081748d2e` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/play.png` | 64x64 px | `121576f875f5387dd00a3412797982ca6ffb68969b951e7b711ef211594de574` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/plugin.png` | 64x64 px | `4953b545524852a4ebc82fb3914db69c59d06e37752b338e2c3553e4b02049a8` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/plus.png` | 64x64 px | `c29a8343775996b9490ce7284648a95a11d6c0b90f12685c098380a1fe45999e` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/refresh.png` | 64x64 px | `0f0dfee9b1c265a85d6dc027fcc22f1dd27ad9e788c5d7903378104f6ea0246b` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/replace.png` | 64x64 px | `fca38112c379a4484709b2df08f4a1ab15651ec2b35d0cb80d7403abdef4bd2d` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/save.png` | 64x64 px | `2270e2dd90c6d370123d446d487d0cd679ee1742f1cf8529a30b19f605b946f6` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/search.png` | 64x64 px | `29f9e692dc73a8cef9b5d233d8372ceecb9e030163a73c450610d7db1d60cb01` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/settings.png` | 64x64 px | `38d1654f865a8c1f42edb72b8c2c2e5c5bc94a464be71f3e4e31f09350ee6f4a` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/split.png` | 64x64 px | `a151748c230221378ce6d4fc58e1f1b5927e14186957829ae2a6f7fe24032e91` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/stop.png` | 64x64 px | `64bf5bcec5d0638372b27b3c94264c060f6e08c719b0dcd42501e86da715ea47` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/sun.png` | 64x64 px | `4819c00edc1964ec0bc7b690684a2b325218c5c7364ec622a660cc4d10955b65` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/terminal.png` | 64x64 px | `f75273f2d4c9b32025ad08e296e4023c5d7ba07950f75ca6fe4f9c571830ba69` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/icon-src/ui/trash.png` | 64x64 px | `79fb3d3203bcd4282e527e669becba0fbde68b0d21bb302af03fc7fb0bf30563` | Repository source only; artwork included in desktop sprite derivative. |
| `apps/desktop/public/icons/sprite.webp` | 320x192 px | `6504e3e84d2b381cf6644bc9964a0907d9e1209eca7fc5af9b90b3514cc1afac` | Desktop frontend dist (Vite public; bundled by Tauri); derivative of the 50 icon-src PNGs above. |
| `apps/desktop/public/pude-favicon.png` | 64x64 px | `6ffa3b05ace75e4ae63854b4fa6f83eafd09dc9175e0759daeb055a25f9bb9df` | Desktop frontend dist (Vite public; bundled by Tauri). |
| `apps/desktop/public/pude-logo.webp` | 256x256 px | `134ebfe2c06fcf07bafa211634675a67518e703313b6e327247f1705139985cc` | Desktop frontend dist (Vite public; bundled by Tauri). |
| `apps/desktop/src-tauri/icons/128x128.png` | 128x128 px | `57b6cd177373280b7f6355bd65314c368b271efce02301dcd53519c9a06d49a0` | Explicit Tauri bundle icon input; applicable platform variant. |
| `apps/desktop/src-tauri/icons/128x128@2x.png` | 256x256 px | `b55f6b01c10d546b8641dec440dd9b54b5153b5852be19286f144bc34d785f21` | Explicit Tauri bundle icon input; applicable platform variant. |
| `apps/desktop/src-tauri/icons/32x32.png` | 32x32 px | `850f25b0f20cd127f7c7710b93e139bc5d0ca61641e610dce43b6d74c261c0fe` | Explicit Tauri bundle icon input; applicable platform variant. |
| `apps/desktop/src-tauri/icons/64x64.png` | 64x64 px | `d179fa015a45fb4beb0526765e4aeb9f469478207ba2c9d10b1361753c6900e1` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-anydpi-v26/ic_launcher.xml` | N/A (Android XML launcher metadata) | `760d4b8a06bf7163dd010c33ad2cac9e4a75fa0177afaba042f83e311eef0c3e` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-hdpi/ic_launcher.png` | 49x49 px | `cb534bdb680bfba5cd7a97dd211f45392f9df836a51b4df1192ede565421640f` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-hdpi/ic_launcher_foreground.png` | 162x162 px | `05c45a61a90dccecb436a9c6ef946c1c0ad73c001dd781aa0e295e59c3012bfa` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-hdpi/ic_launcher_round.png` | 49x49 px | `11f51a3c913dac05c7f3e19417ada9d3f1ddd1c36d9bd7093b421d9f2be67e8a` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-mdpi/ic_launcher.png` | 48x48 px | `782e3e9eb0402eb90209f82a09d09c71e760bfd053ebac3ffbdc4c3c55b90941` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-mdpi/ic_launcher_foreground.png` | 108x108 px | `412be2d25707e7ab15f74c5968c5ddcfec138bd6fac1f14430f50a09c27ef43c` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-mdpi/ic_launcher_round.png` | 48x48 px | `45ddcdcc175723601c445448a5e9c83ba71b4cfb0a8b25e601355565cb5ad888` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-xhdpi/ic_launcher.png` | 96x96 px | `a6e1eb723f1deed19456faa7f3e5153d1a8492ef94b90e85dd987729764dca11` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-xhdpi/ic_launcher_foreground.png` | 216x216 px | `1cd03b3bb408a67d0aaec2bba771040d5a3521f83d11bdc755a35b0dd6b939d4` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-xhdpi/ic_launcher_round.png` | 96x96 px | `aa51cdc3fa6a68e4da279718b0cb308f4fd96996d28be404c0ad8aec3439c012` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-xxhdpi/ic_launcher.png` | 144x144 px | `6ad7b93a03b733524d37e121119942e359a22fadc5dcc30053e2381692cf4555` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-xxhdpi/ic_launcher_foreground.png` | 324x324 px | `d47324d7775e4d2d9b0afc8b58a313fa0dbee08490dd7d1274cc4dc6f91fd123` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-xxhdpi/ic_launcher_round.png` | 144x144 px | `2f31cb0250e85e219b0842c1dd56998b775ccdb602b5db3e7bfe1de435733e66` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher.png` | 192x192 px | `288dbd1cd546d91b5717a93803b3c20dedb7293191e60bf9baf176cdd9ce633e` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher_foreground.png` | 432x432 px | `3dd0531256e1307cdb1ded55eeb789504ca91cea1becac9291ac0712c1293ead` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher_round.png` | 192x192 px | `03d2a656599decf171451a4fca2495c83f5afd3bd03186deacb282fd3a54dec1` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/android/values/ic_launcher_background.xml` | N/A (Android XML launcher metadata) | `0687336f0ccc6f7ee09c7c95110667c63b75931238df779a21af401fb864cd34` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/icon.icns` | ICNS representations: 32x32, 64x64, 128x128, 256x256, 512x512, 1024x1024 px | `1c42e2cd7011b34ae6699fd1cba76b8d31edcf7fd03ec3202470ec7ae16c251a` | Explicit Tauri bundle icon input; applicable platform variant. |
| `apps/desktop/src-tauri/icons/icon.ico` | ICO representations: 32x32, 16x16, 24x24, 48x48, 64x64, 256x256 px | `15609192a787c85fb4c85ca368f07138fb506a2568bbd559b8016d53f068c2a1` | Explicit Tauri bundle icon input; applicable platform variant. |
| `apps/desktop/src-tauri/icons/icon.png` | 512x512 px | `9f207d6124c93ef2c1f7411872ea84945f06f7b1510f1d3d0cf77c284d524493` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-20x20@1x.png` | 20x20 px | `0ab76819bb91a498d198d3242e64861f6993f735a784858b0d68207b60def6ef` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-20x20@2x-1.png` | 40x40 px | `f353895427bc9a6721838741fdcd5a69684b7e468a083b2c901e502ad3c81ddb` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-20x20@2x.png` | 40x40 px | `f353895427bc9a6721838741fdcd5a69684b7e468a083b2c901e502ad3c81ddb` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-20x20@3x.png` | 60x60 px | `08f4c268b2c50afd84f8dcdc932f66d153c284117b3771685a147484e937e90b` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-29x29@1x.png` | 29x29 px | `3c643c7130beb9d16d9ce9ec287e244f9549734cf8f5e7e9256694be2ccd17ed` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-29x29@2x-1.png` | 58x58 px | `3b5459cdc83be108bf424d951428148987f14a810b659e02f3dc7f2dbc69e7db` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-29x29@2x.png` | 58x58 px | `3b5459cdc83be108bf424d951428148987f14a810b659e02f3dc7f2dbc69e7db` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-29x29@3x.png` | 87x87 px | `f1b7f5b6c513d6fcef82267a030ca166756c2d0778068b39cd3af61ad87c9ba3` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-40x40@1x.png` | 40x40 px | `f353895427bc9a6721838741fdcd5a69684b7e468a083b2c901e502ad3c81ddb` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-40x40@2x-1.png` | 80x80 px | `53c64212241e719decf1a44a612b7452a53f0eb29dd8887ccdfa4520cf07b866` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-40x40@2x.png` | 80x80 px | `53c64212241e719decf1a44a612b7452a53f0eb29dd8887ccdfa4520cf07b866` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-40x40@3x.png` | 120x120 px | `458bd11ab5be91ed69d37550195222ef82db5c26d7f4b6cff052a0ef759d94ac` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-512@2x.png` | 1024x1024 px | `fa1ce53eb620ad3f1e4e9a302c616fd5e5a09b04c9596e4bfed569ea9c2225aa` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-60x60@2x.png` | 120x120 px | `458bd11ab5be91ed69d37550195222ef82db5c26d7f4b6cff052a0ef759d94ac` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-60x60@3x.png` | 180x180 px | `ebd5d8fd29ca32aa7195d98209c23711aad4e862952c771090f36482990f2319` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-76x76@1x.png` | 76x76 px | `94af8962cb925b7f360789611d688dcb245beb23079cec0cba57ed16ea6f25b3` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-76x76@2x.png` | 152x152 px | `c5c8e98a7d5d535c9126ecbf5406f99c9dc55a96cbc4a92f920810df3595b10e` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/ios/AppIcon-83.5x83.5@2x.png` | 167x167 px | `d0ad1655f029e9617bfdf06935960261c084aa5834abbaed08ca11f04585de57` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/pude-app-icon.png` | 512x512 px | `9352f34917525fa299e00fa0a401ef9f931149447cc1fc1fc370d546fbcfa8fa` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/Square107x107Logo.png` | 107x107 px | `381db6fbd93a4371e5ae878cfb32518bbeca0b126c7049bc77a65149816893ef` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/Square142x142Logo.png` | 142x142 px | `db47dd2b3c6d67bde58f4dc6ac39e8109f764c2c3259eeef17ffae02db0cda6a` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/Square150x150Logo.png` | 150x150 px | `c1ec418888411c49ffc019fb840f1b5f782e568a56cac226d30489ed720a0e7c` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/Square284x284Logo.png` | 284x284 px | `391ffb7fc8d46b8cde05d10b925501e13ec23bfb9ed582c62bd7bf4b9d8b4975` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/Square30x30Logo.png` | 30x30 px | `f5c169aef8f067cdeae857111775e81a231b2a6c420c030346ac660e2e447f80` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/Square310x310Logo.png` | 310x310 px | `0a58b0f2373e935b6fccedbc9c33c34f27ab0969ba61b2f3f5044440d34c7f6e` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/Square44x44Logo.png` | 44x44 px | `86984c5cca04634ecab8d39067d4e32833f56a31c4bc15c147be3cab5736fee6` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/Square71x71Logo.png` | 71x71 px | `322c6df603675f26e3c54e89cbccf1d3e50a1f4f1505bac91f4b71705bd5e998` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/Square89x89Logo.png` | 89x89 px | `b2c04105351fa022b5fdf1abbafce02dd5ba8299daab491189b3f8394c2cbbad` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/desktop/src-tauri/icons/StoreLogo.png` | 50x50 px | `97c504eefdb4c9ae182aff6ab012c8454f8fb1880cedcb099ad777c21bab3ff2` | Source repository only; not in tauri.conf.json bundle.icon. |
| `apps/web/public/og-image.jpg` | 1280x640 px JPEG | `08a7fce55ace425b6caa2e7069e02968d6b5e0277fc0980932f7eab2cd52242a` | Website dist (Vite public) and the GitHub repository social preview source (the same file is uploaded in the repository settings); the production brief is in `docs/github-social-preview.prompt.txt`. |
| `apps/web/public/pude-favicon.png` | 128x128 px | `4430d99287845538df9c6d34414de037502e2fff10b570c290489266254faefb` | Website dist (Vite public). |
| `apps/web/public/pude-logo.png` | 512x512 px | `9352f34917525fa299e00fa0a401ef9f931149447cc1fc1fc370d546fbcfa8fa` | Website dist (Vite public). |
| `apps/web/public/shots/diff.webp` | 1708x979 px | `de845cb65644f332f623365d328d89281548bbea2b9c4a69d85e69a28a6bb222` | Website dist (Vite public). |
| `apps/web/public/shots/editor.webp` | 1708x979 px | `f3cf65d3b96b4c15b8296721a4743ac478264d22c87137fb15baef59aff722d5` | Website dist (Vite public). |
| `apps/web/public/shots/git.webp` | 1708x979 px | `1d36433babbcbb81a216ce20296e048018c43a88091bb6e08b5a28ef3659a83d` | Website dist (Vite public). |
| `apps/web/public/shots/markdown.webp` | 1708x979 px | `b1bc59b0062703315522e2666ea493c1f2aa5002d9ac762b4eacf729eb7b502f` | Website dist (Vite public). |
| `apps/web/public/shots/terminal.webp` | 1708x979 px | `c9072362b8fa5b2a0651216921d202646b399b5ee09f03c578b1a91ae68108a2` | Website dist (Vite public). |

### Later updates

When an asset is added, replaced, cropped again, recompressed or distributed somewhere else, record its path, dimensions or format, SHA-256 and actual website, desktop or Tauri distribution scope again. When a new asset was not made by the maintainer or generated with AI, also check its source, author or rights holder and license or notice. Never infer a source or license from a file name, the committer or visual similarity alone.
