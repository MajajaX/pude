export { parseSemver } from "./semver.mjs";
export const LATEST_RELEASE_URL: string;
export const TAGGED_RELEASE_PREFIX: string;
export function isValidReleaseTag(tag: unknown): boolean;
export function getPublishedReleaseUrl(value: string | undefined): string | undefined;
