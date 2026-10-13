import { getPublishedReleaseUrl, parseSemver } from "../../../../shared/release-validation";

const RELEASE_ORIGIN = "https://github.com";
const LATEST_RELEASE_PATH = "/MajajaX/pude/releases/latest";
export const LATEST_RELEASE_URL = `${RELEASE_ORIGIN}${LATEST_RELEASE_PATH}`;

export type AboutReleaseTarget = {
  url?: string;
  action?: "check" | "download";
};

export { getPublishedReleaseUrl };

export function getReleaseStage(version: string): string {
  const parsed = parseSemver(version);
  if (!parsed || parsed.prerelease) return "Development preview";
  return "Manual updates";
}

export function getAboutReleaseTarget(version: string, configuredUrl: string | undefined): AboutReleaseTarget {
  const parsed = parseSemver(version);
  if (!parsed || parsed.prerelease) return {};
  if (configuredUrl === undefined || configuredUrl === "") return { url: LATEST_RELEASE_URL, action: "check" };

  const releaseUrl = getPublishedReleaseUrl(configuredUrl);
  return releaseUrl ? { url: releaseUrl, action: "download" } : {};
}
