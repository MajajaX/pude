import { REPOSITORY_URL } from "./repository.mjs";
import { parseSemver } from "./semver.mjs";

export { parseSemver };

export const LATEST_RELEASE_URL = `${REPOSITORY_URL}/releases/latest`;
export const TAGGED_RELEASE_PREFIX = `${REPOSITORY_URL}/releases/tag/`;

/** A `v` tag followed by a semantic version, such as v1.2.3. */
export function isValidReleaseTag(tag) {
  return typeof tag === "string" && tag.startsWith("v") && parseSemver(tag.slice(1)) !== undefined;
}

/**
 * The URL when it is exactly this repository's latest-release page or the page of
 * one valid release tag, written in canonical form; otherwise undefined.
 */
export function getPublishedReleaseUrl(value) {
  if (!value) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.href !== value || url.username || url.password || url.port || url.search || url.hash) return undefined;
  if (value === LATEST_RELEASE_URL) return value;
  if (!value.startsWith(TAGGED_RELEASE_PREFIX)) return undefined;
  return isValidReleaseTag(value.slice(TAGGED_RELEASE_PREFIX.length)) ? value : undefined;
}
