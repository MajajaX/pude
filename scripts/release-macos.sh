#!/usr/bin/env bash
# Builds, signs, notarizes, staples and verifies the macOS arm64 DMG on this Mac.
#
# Required: a "Developer ID Application" certificate in the login keychain and
# one set of notarization credentials in the environment:
#   App Store Connect API key: APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_PATH
#   Apple ID:                  APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID
# APPLE_SIGNING_IDENTITY is optional when exactly one Developer ID identity exists.
# The updater signing key is also required: TAURI_SIGNING_PRIVATE_KEY (key file or contents)
# and TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
# Values may also be exported from ~/.config/pude/release.env, which is loaded when present.
set -euo pipefail

local_environment="$HOME/.config/pude/release.env"
if [[ -f "$local_environment" ]]; then
  source "$local_environment"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="aarch64-apple-darwin"
bundle_root="$repo_root/apps/desktop/src-tauri/target"
bundle_directory="$bundle_root/$target/release/bundle"
output_directory="$repo_root/dist/release-macos"
dmg_name="pude-macos-arm64.dmg"

fail() {
  echo "Release is blocked: $1" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || fail "the macOS release must be built on an Apple Silicon Mac."

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  identities="$(security find-identity -v -p codesigning | grep '"Developer ID Application:' || true)"
  [[ -n "$identities" ]] || fail "no 'Developer ID Application' certificate in the keychain (an 'Apple Distribution' certificate cannot sign a DMG for download)."
  [[ "$(wc -l <<<"$identities" | tr -d ' ')" == "1" ]] || fail "several Developer ID identities found; set APPLE_SIGNING_IDENTITY to the one to use."
  APPLE_SIGNING_IDENTITY="$(sed -E 's/.*"(Developer ID Application:[^"]+)".*/\1/' <<<"$identities")"
fi
[[ "$APPLE_SIGNING_IDENTITY" == "Developer ID Application:"* ]] || fail "APPLE_SIGNING_IDENTITY must start with 'Developer ID Application:'."
security find-identity -v -p codesigning | grep -Fq "\"$APPLE_SIGNING_IDENTITY\"" || fail "identity '$APPLE_SIGNING_IDENTITY' is not in the keychain."
APPLE_TEAM_ID="${APPLE_TEAM_ID:-$(sed -E 's/.*\(([A-Z0-9]+)\)$/\1/' <<<"$APPLE_SIGNING_IDENTITY")}"

if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
  [[ -f "$APPLE_API_KEY_PATH" ]] || fail "APPLE_API_KEY_PATH does not point to a file."
  notary_credentials=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" ]]; then
  notary_credentials=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  fail "set notarization credentials (APPLE_API_ISSUER/APPLE_API_KEY/APPLE_API_KEY_PATH or APPLE_ID/APPLE_PASSWORD)."
fi
export APPLE_SIGNING_IDENTITY APPLE_TEAM_ID

[[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" && -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]] || fail "set TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD to sign the update package."

cd "$repo_root"
[[ -z "$(git status --porcelain)" ]] || echo "Warning: the working tree has uncommitted changes." >&2

npm run release:version:check
rm -rf "$bundle_directory/macos" "$bundle_directory/dmg"
# CI=true makes the DMG bundler skip Finder AppleScript, which needs a GUI session.
CI=true npm run tauri:build -- --target "$target" --bundles app,dmg --config src-tauri/tauri.release.conf.json

dmg_path="$(find "$bundle_directory/dmg" -name '*.dmg' -maxdepth 1)"
[[ "$(wc -l <<<"$dmg_path" | tr -d ' ')" == "1" ]] || fail "expected exactly one DMG in $bundle_directory/dmg."

codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg_path"
xcrun notarytool submit "$dmg_path" "${notary_credentials[@]}" --wait
xcrun stapler staple "$dmg_path"

rm -rf "$output_directory"
node scripts/collect-release-bundle.mjs macos "$output_directory" --bundle-root "$bundle_root"
node scripts/verify-release-artifact.mjs macos "$output_directory/$dmg_name"
node scripts/write-checksums.mjs create "$output_directory/SHA256SUMS-macos.txt" \
  "$output_directory/$dmg_name" "$output_directory/LICENSE" \
  "$output_directory/THIRD_PARTY_NOTICES.md" "$output_directory/THIRD_PARTY_LICENSES.md"

echo "macOS release ready in $output_directory"
