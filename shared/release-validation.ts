const RELEASE_ORIGIN = "https://github.com";
const LATEST_RELEASE_PATH = "/MajajaX/pude/releases/latest";
const VERSIONED_RELEASE_PREFIX = "/MajajaX/pude/releases/tag/";

export type ParsedSemver = {
  prerelease: boolean;
};

export function parseSemver(version: string): ParsedSemver | undefined {
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
  if (core.length !== 3 || !core.every(isValidCoreNumber)) return undefined;
  return { prerelease };
}

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

function isValidCoreNumber(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value);
}

function isValidIdentifierList(value: string, prerelease: boolean): boolean {
  if (!value) return false;
  return value.split(".").every((identifier) => {
    if (!/^[0-9A-Za-z-]+$/.test(identifier)) return false;
    return !prerelease || !/^\d+$/.test(identifier) || identifier === "0" || !identifier.startsWith("0");
  });
}
