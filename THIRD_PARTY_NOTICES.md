# Third-party notices

<!-- release-readiness: approved -->

本文件記錄 `pude` 的第三方依賴、素材來源證據與授權狀態。依賴的逐包完整授權原文
由 [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md) 彙整，隨 desktop bundle 一併散布；
本檔仍負責列出直接依賴及待確認的來源／權利。任何「待補／需核對」都表示本檔尚不是可放行的正式 notice。

## 查核範圍與證據

- JavaScript workspace 與直接依賴版本來自 [`apps/desktop/package.json`](./apps/desktop/package.json)、[`apps/web/package.json`](./apps/web/package.json)；實際解析版本、integrity 與 `license` 欄位來自 [`package-lock.json`](./package-lock.json)（lockfile v3）。
- Rust 直接依賴與版本約束來自 [`apps/desktop/src-tauri/Cargo.toml`](./apps/desktop/src-tauri/Cargo.toml)；實際解析版本與 checksum 來自 [`apps/desktop/src-tauri/Cargo.lock`](./apps/desktop/src-tauri/Cargo.lock)。Cargo.lock 本身不記錄 license，因此 Rust 的 license identifier 依相同鎖定版本已發布 crate 的 package metadata 核對；2026-09-27 已檢查目標平台閉包的精確 `.crate` archive、checksum 與命名授權文件。
- 2026-09-27 查核已補齊目前 32 個 npm 直接依賴與 12 個 Cargo 直接依賴的版本／license identifier；完整鎖檔閉包與原始 license 文件盤點見下方日期快照。
- 2026-09-28 LW-05 依賴升級後重核：直接依賴版本已隨 `package-lock.json`／`Cargo.lock` 更新（見下表）；[`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md) 已就升級後的 win/mac runtime 閉包全量重驗（npm 47 個 runtime 套件、49 份授權文件；Cargo macOS arm64 300 個、Windows x64 305 個 runtime crate、兩平台聯集 600 份命名授權文件、18 個以上游精確來源補齊的 crate），逐 archive checksum／SRI 與授權原文雜湊全部相符。
- 專案採 MIT；根目錄 [`LICENSE`](./LICENSE)、root／desktop／web npm metadata 與 Cargo package metadata 已補為 MIT。這只授權專案本身，不延伸到來源、作者或散布權未核對的素材。

- 2026-10-15 v0.1.2：已核對本次更新後的直接依賴版本，並補入目前 macOS／Windows runtime 閉包中尚未列出的 30 個套件版本之精確 archive、lock digest 與授權原文雜湊；歷史版本記錄保留於完整授權清冊。

- 2026-10-19 v0.1.3：Tauri 更新為 2.12.1、updater 更新為 2.14.0；六個更新套件的精確 archive checksum 與授權文件已核對並記錄於完整清冊。Windows 只使用既有的原始 NSIS EXE 更新格式並關閉 ZIP 支援；macOS 與 Linux 保留 tar.gz。安全檢查逐平台解析實際 feature 與依賴，未加入 advisory 忽略規則。網站 OG 與 GitHub social preview 換用相同的 1280x640 品牌圖，產製提示存於 [`docs/github-social-preview.prompt.txt`](./docs/github-social-preview.prompt.txt)，檔案雜湊與散布範圍記錄於下表。

- 2026-10-22：新增介面字型 `@fontsource-variable/inter` 與 `@fontsource-variable/jetbrains-mono`（皆為 5.3.0，OFL-1.1），字型檔隨 desktop bundle 內建、不從網路載入。兩個 npm archive 與 `package-lock.json` SRI 相符，授權原文（含字型版權聲明與完整 SIL Open Font License 1.1）已收錄於完整授權清冊。

- 2026-10-28 v0.1.7：新增直接依賴 `@codemirror/autocomplete` 6.20.4（用於自動補上括號與引號），`@codemirror/view` 更新為 6.43.15、Tauri 更新為 2.12.4、libc 更新為 0.2.191。四個 archive 與 `package-lock.json` SRI／`Cargo.lock` SHA-256 相符，授權文件與前一版完全相同，已記錄於完整清冊。

## JavaScript／npm

### Desktop runtime

下列版本與 license identifier 取自 `package-lock.json` 的對應 `packages["node_modules/…"]` 條目；上游連結是該套件 metadata 所記錄的 repository。

| 套件 | lock 版本 | License identifier | 上游來源 | 使用位置 |
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
| `@xterm/xterm` | 6.0.0 | MIT | [repository](https://github.com/xtermjs/xterm.js) | desktop runtime |
| `codemirror` | 6.0.2 | MIT | [repository](https://github.com/codemirror/basic-setup) | desktop runtime |
| `solid-js` | 1.9.17 | MIT | [repository](https://github.com/solidjs/solid) | desktop and web runtime |

### 建置、型別與測試工具

這些套件不會全部進入 runtime bundle，但會參與可發布的 desktop 或 website 建置、型別檢查與測試，因此版本變更仍要重新查核其 notice。

| 套件 | lock 版本 | License identifier | 上游來源 | 使用位置 |
| --- | ---: | --- | --- | --- |
| `@tauri-apps/cli` | 2.12.3 | Apache-2.0 OR MIT | [repository](https://github.com/tauri-apps/tauri) | desktop build |
| `@xterm/headless` | 6.0.0 | MIT | [repository](https://github.com/xtermjs/xterm.js) | desktop test |
| `fake-indexeddb` | 6.2.6 | Apache-2.0 | [repository](https://github.com/dumbmatter/fakeIndexedDB) | desktop test |
| `@types/node` | 26.6.5 | MIT | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped) | web typecheck |
| `typescript` | 7.0.2 | Apache-2.0 | [repository](https://github.com/microsoft/TypeScript) | desktop and web build |
| `vite` | 8.3.4 | MIT | [repository](https://github.com/vitejs/vite) | desktop and web build |
| `vite-plugin-solid` | 2.11.14 | MIT | [repository](https://github.com/solidjs/vite-plugin-solid) | desktop and web build |
| `vitest` | 5.0.5 | MIT | [repository](https://github.com/vitest-dev/vitest) | desktop test |

### npm 核對限制

`package-lock.json` 的 `license` 欄位只是一個套件 metadata identifier，不是授權全文，也不保證涵蓋所有隨套件散布的 notice。2026-09-27 的 lockfile v3 有 221 個外部 package entries，皆有 `license`、`resolved` 與 `integrity`；所有 `resolved` 指向 `registry.npmjs.org`。以 exact `resolved` URL 暫存本機未具 license file 的 85 個 tarballs，`npm pack` 回報的 integrity 與 lockfile SRI 85/85 相符，tarball 內 metadata 的 license 85/85 與 lockfile 相同。檔案盤點只找到 19 個 tarballs 帶有命名的 `LICENSE`／`LICENCE`／`COPYING`／`NOTICE`／`UNLICENSE`／`COPYRIGHT` 文件；其餘 66 個沒有上述文件。這 85 個包含未安裝的跨平台 optional packages，也包含不隨安裝程式散布的 build／test 工具；因此 66 個 lockfile archive 缺檔不等同於 shipped runtime 缺授權文件。macOS arm64 與 Windows x64 各自的 47-package desktop runtime closure 已逐一核對 exact archive、SPDX 與 48 份原始 license／notice files，產出與來源 hash 詳見 [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md)。

## Rust／Cargo

下列 license identifier 來自相同版本 crate 的 published `Cargo.toml` metadata；版本與 checksum 以 [`Cargo.lock`](./apps/desktop/src-tauri/Cargo.lock) 為準。完整授權全文隨 bundle 收錄於 [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md)。

| crate | lock 版本 | License identifier | 上游來源 | 使用位置 |
| --- | ---: | --- | --- | --- |
| `tauri` | 2.12.4 | Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/tauri/2.12.4) · [repository](https://github.com/tauri-apps/tauri) | runtime |
| `tauri-plugin-single-instance` | 2.5.4 | Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/tauri-plugin-single-instance/2.5.4) · [repository](https://github.com/tauri-apps/plugins-workspace) | runtime；ST-07 單一執行個體 |
| `tauri-build` | 2.7.3 | Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/tauri-build/2.7.3) · [repository](https://github.com/tauri-apps/tauri) | build dependency |
| `cap-std` | 4.0.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/cap-std/4.0.3) · [repository](https://github.com/bytecodealliance/cap-std) | runtime |
| `libc` | 0.2.191 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/libc/0.2.191) · [repository](https://github.com/rust-lang/libc) | runtime |
| `notify` | 8.2.0 | CC0-1.0 | [crates.io](https://crates.io/crates/notify/8.2.0) · [repository](https://github.com/notify-rs/notify) | runtime |
| `portable-pty` | 0.9.0 | MIT | [crates.io](https://crates.io/crates/portable-pty/0.9.0) · [repository](https://github.com/wezterm/wezterm) | runtime |
| `reqwest` | 0.13.5 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/reqwest/0.13.5) · [repository](https://github.com/seanmonstar/reqwest) | runtime |
| `rfd` | 0.17.2 | MIT | [crates.io](https://crates.io/crates/rfd/0.17.2) · [repository](https://github.com/PolyMeilex/rfd) | runtime |
| `serde` | 1.0.229 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/serde/1.0.229) · [repository](https://github.com/serde-rs/serde) | runtime |
| `serde_json` | 1.0.154 | MIT OR Apache-2.0 | [crates.io](https://crates.io/crates/serde_json/1.0.154) · [repository](https://github.com/serde-rs/json) | runtime |
| `tokio` | 1.53.3 | MIT | [crates.io](https://crates.io/crates/tokio/1.53.3) · [repository](https://github.com/tokio-rs/tokio) | runtime |
| `uuid` | 1.28.0 | Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/uuid/1.28.0) · [repository](https://github.com/uuid-rs/uuid) | runtime |

### Cargo 核對限制與 2026-09-27 快照

2026-09-29 ST-07 增量查核：新增 `tauri-plugin-single-instance@2.5.0` 與其啟用的 `tracing-attributes@0.1.31` 已逐 archive 核對 Cargo.lock checksum，四份命名授權文件完整收錄於 `THIRD_PARTY_LICENSES.md`。目前 normal runtime 閉包為 macOS arm64 269、Windows x64 273 個 crate（不含 pude）；既有歷史版本的授權文字仍保留。

`Cargo.lock` 的 package blocks 包含 Tauri runtime、WebView、平台整合、系統繫結與其他轉依賴；lockfile 不含 license 欄位，不能只靠 package name 推定授權。以已鎖定的 `aarch64-apple-darwin` 和 `x86_64-pc-windows-msvc` target 分別執行 `cargo metadata --locked --filter-platform`，normal dependency graph 有 307 個 macOS crates、312 個 Windows crates；加上 build dependency 後分別為 328、335。`.crate` archive SHA-256 與 Cargo.lock checksum 全數匹配（macOS normal+build 328/328；Windows 335/335），且所有這些 package 的 published `Cargo.toml` 都有 `license` 或 `license-file` metadata。實際 shipped normal runtime source trees 遞迴檢查後，macOS 19 個 crate、Windows 11 個 crate、共 22 個不同 crates 未在 `.crate` archive 內找到命名授權文件；這 22 項已依 `.cargo_vcs_info.json` 固定的上游 commit 核對原始授權文字或 package 的授權選擇說明，並在 [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md) 列明來源與雜湊。對 340 個 runtime Cargo crates 遞迴盤點共找到 606 個命名授權／notice 檔；macOS 307、Windows 312 個 normal runtime crates 的全文均已納入。只把實際隨 app 散布的正常 runtime closure 納入本次 F01 release gate；build/test 與 Android-only packages 另列盤點，不作為 app blocker。

## Release 維護規則

1. 先更新對應 manifest，再以 lockfile 的可重現命令更新 [`package-lock.json`](./package-lock.json) 或 [`Cargo.lock`](./apps/desktop/src-tauri/Cargo.lock)；release commit 必須同時提交 manifest 與 lockfile 的變更。
2. 依賴新增、移除或版本變更時，重新核對 exact package/crate 的 license identifier、上游來源、license files 與 notice；若 license 由單一授權變成雙授權或其他 expression，也要更新本文件。
3. 每個 release 對 npm 的完整 lockfile 閉包與 Cargo 的完整 lockfile 閉包執行一次 license／notice inventory。掃描結果應包含平台條件套件與 build/test 工具，不能只掃 runtime bundle。
4. 將必要的第三方 license／notice 文件隨 release artifact 提供，並保留掃描輸入的 lockfile、版本、checksum／integrity 與產出日期。不要以本文件中的 identifier 取代原始授權文件。
5. 若 upstream metadata、repository、license file 或 notice 無法從 exact source 核對，將該項標成「需核對」，由 release owner 在發佈前補證據；不得以猜測補上完整 license 文本。
6. 本文件新增或更新後，檢查所有相對連結仍指向現存 manifest、lockfile 或素材出處文件；若素材替換，也要同步更新 [素材來源紀錄](#asset-provenance)。

## 尚待確認的項目

- macOS arm64 與 Windows x64 的 47-package npm runtime closure、307／312 個 Cargo normal runtime crates 已完成來源 archive／checksum、license metadata 與授權全文核對；逐檔來源與內容雜湊見隨包的 [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md)。其他 build／test／optional lockfile entries 的命名文件缺口不屬於 app runtime gate。

<a id="asset-provenance"></a>

## 現行素材權利聲明與逐檔清冊

維護者確認下表目前的圖像素材由維護者自行製作或 AI 生成，並授權 MajajaX 依專案 [`MIT LICENSE`](./LICENSE) 散布。此聲明涵蓋下表所列檔案。未提供逐項作者、生成工具、外部原始來源 URL 或素材產製日期，因此本紀錄不填寫或推定這些資訊。

清冊包含 `apps/desktop/icon-src` 50 個來源圖示、`apps/desktop/public` 3 個圖像檔案、`apps/web/public` 11 個圖像檔案、`docs` 1 個 social preview 圖像及 `apps/desktop/src-tauri/icons` 53 個檔案。PNG／WebP 尺寸取自檔案標頭，ICO／ICNS 列出容器中的尺寸，SHA-256 覆蓋原始檔 bytes。Android XML launcher 檔列入清冊供完整盤點，尺寸不適用。

兩個 Vite `public` 目錄的檔案會複製到各自 frontend dist；desktop frontend 隨 Tauri app 封裝。`apps/desktop/icon-src` 保留原始 PNG 圖示，不隨 frontend 散布；`scripts/convert-icons.py` 將相同圖像縮為 32x32 cells，產生 `apps/desktop/public/icons/sprite.webp`。Sprite 僅調整尺寸、排列及格式，沿用這 50 個來源圖示的權利聲明。Tauri 目前明列 `32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.icns` 與 `icon.ico` 作為 bundle icon 輸入。Tauri icon 資料夾中其餘項目未列於目前 `tauri.conf.json` 的 `bundle.icon`，不代表當前 Windows／macOS bundle 輸入。

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
| `apps/desktop/public/pude-logo.webp` | 64x256 px | `134ebfe2c06fcf07bafa211634675a67518e703313b6e327247f1705139985cc` | Desktop frontend dist (Vite public; bundled by Tauri). |
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
| `apps/web/public/og-image.png` | 1280x640 px | `9cd4f107797a18fd44e23e3779c67b2e6a4228805f95945e071ffa501bdc73b6` | Website dist (Vite public); same brand artwork as `docs/github-social-preview.png`, with the production brief in `docs/github-social-preview.prompt.txt`. |
| `docs/github-social-preview.png` | 1280x640 px | `9cd4f107797a18fd44e23e3779c67b2e6a4228805f95945e071ffa501bdc73b6` | Repository social preview source; identical to the website OG image. |
| `apps/web/public/pude-app-icon.png` | 128x128 px | `4430d99287845538df9c6d34414de037502e2fff10b570c290489266254faefb` | Website dist (Vite public). |
| `apps/web/public/pude-favicon.png` | 128x128 px | `4430d99287845538df9c6d34414de037502e2fff10b570c290489266254faefb` | Website dist (Vite public). |
| `apps/web/public/pude-favicon.webp` | 64x128 px | `eacb594b8934317d3ad92705f3e1e49e8eeb78b1dd44437a6e070afe5f36203d` | Website dist (Vite public). |
| `apps/web/public/pude-logo.png` | 512x512 px | `9352f34917525fa299e00fa0a401ef9f931149447cc1fc1fc370d546fbcfa8fa` | Website dist (Vite public). |
| `apps/web/public/pude-logo.webp` | 320x512 px | `0783ee19a1f1efee47437c5bfe49750781147095e20516a0b72cfccfc75482ad` | Website dist (Vite public). |
| `apps/web/public/shots/diff.webp` | 1708x979 px | `7c0e5c4de19c52b40e6db2a3bcd220174a8746f8d822603b30775a8bd19e1a1c` | Website dist (Vite public). |
| `apps/web/public/shots/editor.webp` | 1708x979 px | `3653af86a8def38605c52e79f0dba4480db48649ce3e31de327a96b8ea96ea3a` | Website dist (Vite public). |
| `apps/web/public/shots/git.webp` | 1708x979 px | `7a880ce1018c458dd5b7cae8f3ca594f5ab88894d7a3d18ac4c52d7fbafd89c3` | Website dist (Vite public). |
| `apps/web/public/shots/markdown.webp` | 1708x979 px | `be3af827e05ab69989baf28db2fb48583d76fea74386f6d23df41ad1f2397219` | Website dist (Vite public). |
| `apps/web/public/shots/terminal.webp` | 1708x979 px | `a756a859a29f972c175f3577abbaf28ecb6bc2e263fe247a6d6651e215552131` | Website dist (Vite public). |

### 後續更新

新增、替換、重新裁切、重新壓縮或改變素材散布位置時，重新記錄檔案路徑、尺寸／格式、SHA-256 及 website／desktop／Tauri 的實際散布範圍。新素材若不是維護者自行製作或 AI 生成，另核對來源、作者／權利人和 license／notice。不要只依檔名、提交者或視覺相似度推定來源或授權。
