import { parseSemver } from "./semver.mjs";

export { parseSemver };

const RELEASE_ORIGIN = "https://github.com";
const LATEST_RELEASE_PATH = "/MajajaX/pude/releases/latest";
const VERSIONED_RELEASE_PREFIX = "/MajajaX/pude/releases/tag/";

export function getPublishedReleaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (
      url.origin !== RELEASE_ORIGIN ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.href !== value
    ) return undefined;

    if (url.pathname === LATEST_RELEASE_PATH) return value;
    if (!url.pathname.startsWith(VERSIONED_RELEASE_PREFIX)) return undefined;
    return isValidSemverTag(url.pathname.slice(VERSIONED_RELEASE_PREFIX.length)) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isValidSemverTag(tag: string): boolean {
  return tag.startsWith("v") && parseSemver(tag.slice(1)) !== undefined;
}
