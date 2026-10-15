export function parseSemver(version) {
  if (typeof version !== "string") return undefined;
  let versionWithoutBuild = version;
  const buildSeparator = version.indexOf("+");
  if (buildSeparator >= 0) {
    if (version.indexOf("+", buildSeparator + 1) >= 0) return undefined;
    if (!isValidIdentifierList(version.slice(buildSeparator + 1), false)) return undefined;
    versionWithoutBuild = version.slice(0, buildSeparator);
  }

  let core = versionWithoutBuild;
  let prerelease = false;
  const prereleaseSeparator = versionWithoutBuild.indexOf("-");
  if (prereleaseSeparator >= 0) {
    if (!isValidIdentifierList(versionWithoutBuild.slice(prereleaseSeparator + 1), true)) return undefined;
    core = versionWithoutBuild.slice(0, prereleaseSeparator);
    prerelease = true;
  }

  const numbers = core.split(".");
  if (numbers.length !== 3 || !numbers.every((number) => /^(?:0|[1-9]\d*)$/.test(number))) return undefined;
  return { prerelease };
}

function isValidIdentifierList(value, prerelease) {
  if (!value) return false;
  return value.split(".").every((identifier) => {
    if (!/^[0-9A-Za-z-]+$/.test(identifier)) return false;
    return !prerelease || !/^\d+$/.test(identifier) || identifier === "0" || !identifier.startsWith("0");
  });
}
