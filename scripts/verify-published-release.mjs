import { spawnSync } from "node:child_process";

const [releaseUrl, ...options] = process.argv.slice(2);
const platform = options.length === 0 ? "all" : options.length === 2 && options[0] === "--platform" ? options[1] : undefined;
if (!["all", "windows", "macos"].includes(platform)) {
  console.error("expected --platform windows|macos|all");
  process.exit(2);
}
if (!releaseUrl) {
  console.error("usage: verify-published-release.mjs <https://github.com/MajajaX/pude/releases/latest|.../tag/vX.Y.Z[-pre][+build]>");
  process.exit(2);
}

function parseSemver(version) {
  let versionWithoutBuild = version;
  const buildSeparator = version.indexOf("+");
  if (buildSeparator >= 0) {
    if (version.indexOf("+", buildSeparator + 1) >= 0) return undefined;
    const build = version.slice(buildSeparator + 1);
    if (!isValidIdentifierList(build, false)) return undefined;
    versionWithoutBuild = version.slice(0, buildSeparator);
  }

  let coreAndPrerelease = versionWithoutBuild;
  let prerelease = false;
  const prereleaseSeparator = versionWithoutBuild.indexOf("-");
  if (prereleaseSeparator >= 0) {
    const identifiers = versionWithoutBuild.slice(prereleaseSeparator + 1);
    if (!isValidIdentifierList(identifiers, true)) return undefined;
    coreAndPrerelease = versionWithoutBuild.slice(0, prereleaseSeparator);
    prerelease = true;
  }

  const core = coreAndPrerelease.split(".");
  if (core.length !== 3 || !core.every((part) => /^(?:0|[1-9]\d*)$/.test(part))) return undefined;
  return { prerelease };
}

function isValidIdentifierList(value, prerelease) {
  if (!value) return false;
  return value.split(".").every((identifier) => {
    if (!/^[0-9A-Za-z-]+$/.test(identifier)) return false;
    return !prerelease || !/^\d+$/.test(identifier) || identifier === "0" || !identifier.startsWith("0");
  });
}

function isValidTag(tag) {
  return tag.startsWith("v") && parseSemver(tag.slice(1)) !== undefined;
}

let url;
try {
  url = new URL(releaseUrl);
} catch {
  console.error("release URL must be an absolute GitHub Releases URL");
  process.exit(1);
}

const latestPath = "/MajajaX/pude/releases/latest";
const versionedPrefix = "/MajajaX/pude/releases/tag/";
const isLatest = url.pathname === latestPath;
let requestedTag;
if (url.pathname.startsWith(versionedPrefix)) {
  const encodedTag = url.pathname.slice(versionedPrefix.length);
  try {
    requestedTag = decodeURIComponent(encodedTag);
  } catch {
    requestedTag = undefined;
  }
}

if (
  url.protocol !== "https:" ||
  url.hostname !== "github.com" ||
  url.port ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  url.href !== releaseUrl ||
  (!isLatest && (!requestedTag || !isValidTag(requestedTag) || url.pathname !== `${versionedPrefix}${requestedTag}`))
) {
  console.error("release URL must exactly match /MajajaX/pude/releases/latest or /MajajaX/pude/releases/tag/v<canonical-semver>");
  process.exit(1);
}

const endpoint = isLatest
  ? "repos/MajajaX/pude/releases/latest"
  : `repos/MajajaX/pude/releases/tags/${encodeURIComponent(requestedTag)}`;
function requestApi(path, label) {
  const result = spawnSync("gh", ["api", path], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    console.error(`Could not verify ${label} through GitHub API${result.stderr ? `: ${result.stderr.trim()}` : "."}`);
    process.exit(1);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    console.error(`GitHub API returned invalid ${label} metadata`);
    process.exit(1);
  }
}

const repository = requestApi("repos/MajajaX/pude", "repository visibility");
if (repository.full_name !== "MajajaX/pude" || repository.private !== false || repository.visibility !== "public") {
  console.error("The configured release must belong to the public MajajaX/pude repository.");
  process.exit(1);
}
const release = requestApi(endpoint, "published release");

function urlHasOriginAndPath(value, hostname, expectedPath) {
  try {
    const candidate = new URL(value);
    return candidate.protocol === "https:" && candidate.hostname === hostname && !candidate.port && !candidate.username && !candidate.password && !candidate.search && !candidate.hash && candidate.pathname === expectedPath;
  } catch {
    return false;
  }
}

function validDownloadUrl(value, tag, name) {
  try {
    const candidate = new URL(value);
    const segments = candidate.pathname.split("/").slice(1);
    return candidate.protocol === "https:" && candidate.hostname === "github.com" && !candidate.port && !candidate.username && !candidate.password && !candidate.search && !candidate.hash && segments.length === 6 && segments[0] === "MajajaX" && segments[1] === "pude" && segments[2] === "releases" && segments[3] === "download" && decodeURIComponent(segments[4]) === tag && decodeURIComponent(segments[5]) === name;
  } catch {
    return false;
  }
}

const actualTag = typeof release?.tag_name === "string" ? release.tag_name : "";
const actualVersion = isValidTag(actualTag) ? parseSemver(actualTag.slice(1)) : undefined;
let htmlTag;
try {
  const htmlUrl = new URL(release.html_url);
  const htmlPrefix = "/MajajaX/pude/releases/tag/";
  htmlTag = htmlUrl.pathname.startsWith(htmlPrefix) ? decodeURIComponent(htmlUrl.pathname.slice(htmlPrefix.length)) : undefined;
  if (htmlUrl.protocol !== "https:" || htmlUrl.hostname !== "github.com" || htmlUrl.port || htmlUrl.username || htmlUrl.password || htmlUrl.search || htmlUrl.hash) htmlTag = undefined;
} catch {
  htmlTag = undefined;
}

if (
  !Number.isSafeInteger(release.id) ||
  release.id <= 0 ||
  release.draft !== false ||
  release.prerelease !== false ||
  !actualVersion ||
  actualVersion.prerelease ||
  (requestedTag && actualTag !== requestedTag) ||
  htmlTag !== actualTag ||
  !urlHasOriginAndPath(release.url, "api.github.com", `/repos/MajajaX/pude/releases/${release.id}`) ||
  !urlHasOriginAndPath(release.assets_url, "api.github.com", `/repos/MajajaX/pude/releases/${release.id}/assets`)
) {
  console.error("GitHub API response is not a published release from MajajaX/pude matching the configured route");
  process.exit(1);
}

const assets = release.assets;
if (!Array.isArray(assets)) {
  console.error("GitHub release response has no asset list");
  process.exit(1);
}

const assetNames = new Set();
for (const asset of assets) {
  if (
    !Number.isSafeInteger(asset?.id) ||
    asset.id <= 0 ||
    typeof asset.name !== "string" ||
    assetNames.has(asset.name) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    !urlHasOriginAndPath(asset.url, "api.github.com", `/repos/MajajaX/pude/releases/assets/${asset.id}`) ||
    !validDownloadUrl(asset.browser_download_url, actualTag, asset.name)
  ) {
    console.error("GitHub release contains a malformed, duplicate, empty, or cross-repository asset record");
    process.exit(1);
  }
  assetNames.add(asset.name);
}

const requiredAssets = [
  ...(platform !== "macos" ? ["pude-windows-x64-setup.exe", "pude-windows-x64-setup.exe.sig"] : []),
  ...(platform !== "windows" ? ["pude-macos-arm64.dmg", "pude-macos-arm64.app.tar.gz", "pude-macos-arm64.app.tar.gz.sig"] : []),
  "latest.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_LICENSES.md",
  "SHA256SUMS.txt",
];
const missing = requiredAssets.filter((name) => !assetNames.has(name));
if (missing.length > 0) {
  console.error(`published release is missing required assets: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Verified published release ${release.html_url} for ${platform}, with legal notices and SHA256 assets.`);
