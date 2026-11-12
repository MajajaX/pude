import assert from "node:assert/strict";
import test from "node:test";
import { updateListedVersions } from "./verify-notice-versions.mjs";

const notices = [
  "| `@tauri-apps/api` | 2.12.4 | Apache-2.0 OR MIT | [repository](https://github.com/tauri-apps/tauri) | desktop runtime |",
  "| `tauri` | 2.12.4 | Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/tauri/2.12.4) · [repository](https://github.com/tauri-apps/tauri) | runtime |",
  "| `tauri-build` | 2.7.4 | Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/tauri-build/2.7.4) · [repository](https://github.com/tauri-apps/tauri) | build dependency |",
].join("\n");

test("an outdated crate row gets the locked version in its cell and crates.io link", () => {
  const updated = updateListedVersions(notices, new Map([["tauri", "2.12.5"]]));
  assert.equal(
    updated.split("\n")[1],
    "| `tauri` | 2.12.5 | Apache-2.0 OR MIT | [crates.io](https://crates.io/crates/tauri/2.12.5) · [repository](https://github.com/tauri-apps/tauri) | runtime |",
  );
  assert.equal(updated.split("\n")[0], notices.split("\n")[0]);
  assert.equal(updated.split("\n")[2], notices.split("\n")[2]);
});

test("an outdated npm row gets the locked version", () => {
  const updated = updateListedVersions(notices, new Map([["@tauri-apps/api", "2.13.0"]]));
  assert.match(updated, /^\| `@tauri-apps\/api` \| 2\.13\.0 \| Apache-2\.0 OR MIT \|/m);
});

test("current, unresolved and unlisted dependencies leave the notices unchanged", () => {
  const versions = new Map([
    ["tauri", "2.12.4"],
    ["tauri-build", undefined],
    ["new-crate", "1.0.0"],
  ]);
  assert.equal(updateListedVersions(notices, versions), notices);
});
