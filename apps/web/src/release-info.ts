import { getPublishedReleaseUrl, parseSemver } from "../../../shared/release-validation";

export type ReleaseStage = "preview" | "candidate" | "published";

export { getPublishedReleaseUrl };

export function getReleaseStage(version: string, releaseUrl?: string): ReleaseStage {
  const parsed = parseSemver(version);
  if (!parsed || parsed.prerelease) return "preview";
  return releaseUrl ? "published" : "candidate";
}

export const REPOSITORY_URL = "https://github.com/MajajaX/pude";
const VERSIONED_RELEASE_PREFIX = `${REPOSITORY_URL}/releases/tag/`;
/** A tagged release URL is only usable when it is the release the site says it is showing. */
export function getReleaseUrlForVersion(value: string | undefined, version: string): string | undefined {
  const releaseUrl = getPublishedReleaseUrl(value);
  if (!releaseUrl?.startsWith(VERSIONED_RELEASE_PREFIX)) return releaseUrl;
  return releaseUrl.slice(VERSIONED_RELEASE_PREFIX.length) === `v${version}` ? releaseUrl : undefined;
}

export const MACOS_INSTALLER = "pude-macos-arm64.dmg";
export const WINDOWS_INSTALLER = "pude-windows-x64-setup.exe";
export const INSTALLERS = { windows: WINDOWS_INSTALLER, macos: MACOS_INSTALLER } as const;
export type InstallerPlatform = keyof typeof INSTALLERS;

/** Direct download link for one release asset, from a validated release page URL. */
export function getAssetDownloadUrl(releaseUrl: string, fileName: string): string {
  const latestUrl = `${REPOSITORY_URL}/releases/latest`;
  if (releaseUrl === latestUrl) return `${latestUrl}/download/${fileName}`;
  const tag = releaseUrl.slice(VERSIONED_RELEASE_PREFIX.length);
  return `${REPOSITORY_URL}/releases/download/${tag}/${fileName}`;
}
