import { getPublishedReleaseUrl, parseSemver } from "../../../shared/release-validation";

export type ReleaseStage = "preview" | "candidate" | "published";

export { getPublishedReleaseUrl };

export function getReleaseStage(version: string, releaseUrl?: string): ReleaseStage {
  const parsed = parseSemver(version);
  if (!parsed || parsed.prerelease) return "preview";
  return releaseUrl ? "published" : "candidate";
}

export const REPOSITORY_URL = "https://github.com/MajajaX/pude";
export const MACOS_INSTALLER = "pude-macos-arm64.dmg";
export const WINDOWS_INSTALLER = "pude-windows-x64-setup.exe";
export const INSTALLERS = { windows: WINDOWS_INSTALLER, macos: MACOS_INSTALLER } as const;
export type InstallerPlatform = keyof typeof INSTALLERS;

/** Direct download link for one release asset, from a validated release page URL. */
export function getAssetDownloadUrl(releaseUrl: string, fileName: string): string {
  const latestUrl = `${REPOSITORY_URL}/releases/latest`;
  if (releaseUrl === latestUrl) return `${latestUrl}/download/${fileName}`;
  const tag = releaseUrl.slice(`${REPOSITORY_URL}/releases/tag/`.length);
  return `${REPOSITORY_URL}/releases/download/${tag}/${fileName}`;
}
