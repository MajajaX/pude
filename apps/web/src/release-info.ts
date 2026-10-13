import { getPublishedReleaseUrl, parseSemver } from "../../../shared/release-validation";

export type ReleaseStage = "preview" | "candidate" | "published";

export { getPublishedReleaseUrl };

export function getReleaseStage(version: string, releaseUrl?: string): ReleaseStage {
  const parsed = parseSemver(version);
  if (!parsed || parsed.prerelease) return "preview";
  return releaseUrl ? "published" : "candidate";
}
