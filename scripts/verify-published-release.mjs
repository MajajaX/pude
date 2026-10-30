import { spawnSync } from "node:child_process";
import { parseSemver } from "../shared/semver.mjs";

const [releaseUrl, ...options] = process.argv.slice(2);
let platform = "all";
let expectDraft = false;
for (let index = 0; index < options.length; index += 1) {
  if (options[index] === "--platform" && options[index + 1]) platform = options[++index];
  else if (options[index] === "--draft") expectDraft = true;
  else platform = undefined;
}
if (!["all", "windows", "macos"].includes(platform)) {
  console.error("expected [--platform windows|macos|all] [--draft]");
  process.exit(2);
}
if (!releaseUrl) {
  console.error("usage: verify-published-release.mjs <https://github.com/MajajaX/pude/releases/latest|.../tag/vX.Y.Z[-pre][+build]> [--platform windows|macos|all] [--draft]");
  process.exit(2);
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

if (expectDraft && isLatest) {
  console.error("--draft verifies one tagged release, so the URL must be /MajajaX/pude/releases/tag/v<canonical-semver>");
  process.exit(1);
}

function runGitHubApi(args, label) {
  const result = spawnSync("gh", ["api", ...args], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    console.error(`Could not verify ${label} through GitHub API${result.stderr ? `: ${result.stderr.trim()}` : "."}`);
    process.exit(1);
  }
  return result.stdout;
}

function requestApi(path, label) {
  try {
    return JSON.parse(runGitHubApi([path], label));
  } catch {
    console.error(`GitHub API returned invalid ${label} metadata`);
    process.exit(1);
  }
}

/** The tag endpoint never returns drafts, so a draft is found in the release list. */
function requestDraftRelease(tag) {
  const releases = requestApi("repos/MajajaX/pude/releases?per_page=20", "draft release list");
  const drafts = Array.isArray(releases) ? releases.filter((candidate) => candidate?.draft === true && candidate.tag_name === tag) : [];
  if (drafts.length !== 1) {
    console.error(`expected exactly one draft release for ${tag}, found ${drafts.length}`);
    process.exit(1);
  }
  return drafts[0];
}

function requestAssetText(asset, label) {
  return runGitHubApi(["-H", "Accept: application/octet-stream", `repos/MajajaX/pude/releases/assets/${asset.id}`], label);
}

const repository = requestApi("repos/MajajaX/pude", "repository visibility");
if (repository.full_name !== "MajajaX/pude" || repository.private !== false || repository.visibility !== "public") {
  console.error("The configured release must belong to the public MajajaX/pude repository.");
  process.exit(1);
}
const release = expectDraft
  ? requestDraftRelease(requestedTag)
  : requestApi(isLatest ? "repos/MajajaX/pude/releases/latest" : `repos/MajajaX/pude/releases/tags/${encodeURIComponent(requestedTag)}`, "published release");
const releaseKind = expectDraft ? "draft" : "published";

function urlHasOriginAndPath(value, hostname, expectedPath) {
  try {
    const candidate = new URL(value);
    return candidate.protocol === "https:" && candidate.hostname === hostname && !candidate.port && !candidate.username && !candidate.password && !candidate.search && !candidate.hash && candidate.pathname === expectedPath;
  } catch {
    return false;
  }
}

/** A draft's assets are served from an `untagged-<hash>` path until it is published. */
function isReleaseDownloadSegment(segment, tag) {
  return segment === tag || (expectDraft && /^untagged-[0-9a-f]+$/.test(segment));
}

function validDownloadUrl(value, tag, name) {
  try {
    const candidate = new URL(value);
    const segments = candidate.pathname.split("/").slice(1);
    return candidate.protocol === "https:" && candidate.hostname === "github.com" && !candidate.port && !candidate.username && !candidate.password && !candidate.search && !candidate.hash && segments.length === 6 && segments[0] === "MajajaX" && segments[1] === "pude" && segments[2] === "releases" && segments[3] === "download" && isReleaseDownloadSegment(decodeURIComponent(segments[4]), tag) && decodeURIComponent(segments[5]) === name;
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
// A draft's page is /releases/tag/untagged-<hash> until it is published.
const htmlPageMatches = expectDraft ? isReleaseDownloadSegment(htmlTag ?? "", actualTag) : htmlTag === actualTag;

if (
  !Number.isSafeInteger(release.id) ||
  release.id <= 0 ||
  release.draft !== expectDraft ||
  release.prerelease !== false ||
  !actualVersion ||
  actualVersion.prerelease ||
  (requestedTag && actualTag !== requestedTag) ||
  !htmlPageMatches ||
  !urlHasOriginAndPath(release.url, "api.github.com", `/repos/MajajaX/pude/releases/${release.id}`) ||
  !urlHasOriginAndPath(release.assets_url, "api.github.com", `/repos/MajajaX/pude/releases/${release.id}/assets`)
) {
  console.error(`GitHub API response is not a ${releaseKind} release from MajajaX/pude matching the configured route`);
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
  console.error(`${releaseKind} release is missing required assets: ${missing.join(", ")}`);
  process.exit(1);
}

const checksumFile = assets.find((asset) => asset.name === "SHA256SUMS.txt");
const checksummedNames = new Set(
  requestAssetText(checksumFile, "SHA256SUMS.txt").split(/\r?\n/).filter(Boolean).map((line) => line.split("  ")[1]),
);
const unchecksummed = requiredAssets.filter((name) => name !== "SHA256SUMS.txt" && !checksummedNames.has(name));
if (unchecksummed.length > 0) {
  console.error(`SHA256SUMS.txt does not list: ${unchecksummed.join(", ")}`);
  process.exit(1);
}

console.log(`Verified ${releaseKind} release ${release.html_url} for ${platform}, with legal notices and SHA256 assets covering every download.`);
