import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSemver } from "../shared/semver.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const paths = {
  rootPackage: "package.json",
  desktopPackage: "apps/desktop/package.json",
  webPackage: "apps/web/package.json",
  packageLock: "package-lock.json",
  cargoManifest: "apps/desktop/src-tauri/Cargo.toml",
  cargoLock: "apps/desktop/src-tauri/Cargo.lock",
  tauriConfig: "apps/desktop/src-tauri/tauri.conf.json",
};

function fail(message) {
  console.error(`release-version: ${message}`);
  process.exitCode = 1;
}

function validVersion(version) {
  return parseSemver(version) !== undefined;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function readText(path) {
  return readFile(resolve(root, path), "utf8");
}

function replaceFirst(source, expression, replacement, label) {
  if (!expression.test(source)) throw new Error(`could not locate ${label}`);
  return source.replace(expression, replacement);
}

async function sync(version) {
  if (!validVersion(version)) {
    throw new Error("expected a semantic version such as 0.1.0 or 1.0.0");
  }

  for (const path of [paths.rootPackage, paths.desktopPackage, paths.webPackage]) {
    const manifest = await readJson(path);
    manifest.version = version;
    await writeFile(resolve(root, path), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const packageLock = await readJson(paths.packageLock);
  packageLock.version = version;
  packageLock.packages[""].version = version;
  packageLock.packages["apps/desktop"].version = version;
  packageLock.packages["apps/web"].version = version;
  await writeFile(resolve(root, paths.packageLock), `${JSON.stringify(packageLock, null, 2)}\n`);

  const cargoManifest = await readText(paths.cargoManifest);
  const updatedCargoManifest = replaceFirst(
    cargoManifest,
    /(\[package\][\s\S]*?^version = ")[^"]+("[\s\S]*?)(?=^\[|\s*$)/m,
    `$1${version}$2`,
    "Cargo package version",
  );
  await writeFile(resolve(root, paths.cargoManifest), updatedCargoManifest);

  const cargoLock = await readText(paths.cargoLock);
  const updatedCargoLock = replaceFirst(
    cargoLock,
    /(\[\[package\]\]\r?\nname = "pude"\r?\nversion = ")[^"]+/,
    `$1${version}`,
    "Cargo lock package version",
  );
  await writeFile(resolve(root, paths.cargoLock), updatedCargoLock);

  const tauriConfig = await readJson(paths.tauriConfig);
  tauriConfig.version = version;
  await writeFile(resolve(root, paths.tauriConfig), `${JSON.stringify(tauriConfig, null, 2)}\n`);

  console.log(`Synchronized all release version locations to ${version}.`);
}

async function inspectVersions() {
  const rootPackage = await readJson(paths.rootPackage);
  const desktopPackage = await readJson(paths.desktopPackage);
  const webPackage = await readJson(paths.webPackage);
  const packageLock = await readJson(paths.packageLock);
  const tauriConfig = await readJson(paths.tauriConfig);
  const cargoManifest = await readText(paths.cargoManifest);
  const cargoLock = await readText(paths.cargoLock);

  const cargoManifestVersion = cargoManifest.match(
    /^\[package\][\s\S]*?^version = "([^"]+)"/m,
  )?.[1];
  const cargoLockVersion = cargoLock.match(
    /^\[\[package\]\]\r?\nname = "pude"\r?\nversion = "([^"]+)"/m,
  )?.[1];

  return new Map([
    [paths.rootPackage, rootPackage.version],
    [paths.desktopPackage, desktopPackage.version],
    [paths.webPackage, webPackage.version],
    [paths.packageLock, packageLock.version],
    ["package-lock.json packages[\"\"]", packageLock.packages?.[""]?.version],
    ["package-lock.json packages[\"apps/desktop\"]", packageLock.packages?.["apps/desktop"]?.version],
    ["package-lock.json packages[\"apps/web\"]", packageLock.packages?.["apps/web"]?.version],
    [paths.cargoManifest, cargoManifestVersion],
    [paths.cargoLock, cargoLockVersion],
    [paths.tauriConfig, tauriConfig.version],
  ]);
}

async function check(expectedVersion) {
  if (expectedVersion && !validVersion(expectedVersion)) {
    throw new Error(`invalid expected version: ${expectedVersion}`);
  }

  const versions = await inspectVersions();
  const distinctVersions = new Set(versions.values());
  if (distinctVersions.size !== 1 || [...versions.values()].some((value) => !validVersion(value))) {
    const details = [...versions].map(([path, version]) => `  ${path}: ${version ?? "missing"}`).join("\n");
    throw new Error(`release version locations are missing or out of sync:\n${details}`);
  }

  const [currentVersion] = distinctVersions;
  if (expectedVersion && currentVersion !== expectedVersion) {
    throw new Error(`expected ${expectedVersion}, found ${currentVersion}`);
  }

  const rootPackage = await readJson(paths.rootPackage);
  const desktopPackage = await readJson(paths.desktopPackage);
  const webPackage = await readJson(paths.webPackage);
  const cargoManifest = await readText(paths.cargoManifest);
  const tauriConfig = await readJson(paths.tauriConfig);
  const license = await readText("LICENSE");
  const thirdPartyNotices = await readText("THIRD_PARTY_NOTICES.md");
  const thirdPartyLicenses = await readText("THIRD_PARTY_LICENSES.md");

  for (const [path, manifest] of [
    [paths.rootPackage, rootPackage],
    [paths.desktopPackage, desktopPackage],
    [paths.webPackage, webPackage],
  ]) {
    if (manifest.license !== "MIT" || manifest.author !== "MajajaX") {
      throw new Error(`${path} must declare author MajajaX and license MIT`);
    }
  }
  if (!/^license = "MIT"\r?$/m.test(cargoManifest) || !/^authors = \["MajajaX"\]\r?$/m.test(cargoManifest)) {
    throw new Error(`${paths.cargoManifest} must declare MajajaX and license MIT`);
  }
  if (!license.includes("Copyright (c) 2026 MajajaX")) {
    throw new Error("LICENSE does not identify the agreed copyright holder and year");
  }
  if (tauriConfig.bundle?.macOS?.minimumSystemVersion !== "14.0") {
    throw new Error(`${paths.tauriConfig} must set macOS minimumSystemVersion to 14.0`);
  }
  if (
    tauriConfig.bundle?.resources?.["../../../LICENSE"] !== "LICENSE" ||
    tauriConfig.bundle?.resources?.["../../../THIRD_PARTY_NOTICES.md"] !== "THIRD_PARTY_NOTICES.md" ||
    tauriConfig.bundle?.resources?.["../../../THIRD_PARTY_LICENSES.md"] !== "THIRD_PARTY_LICENSES.md"
  ) {
    throw new Error(`${paths.tauriConfig} must bundle LICENSE, THIRD_PARTY_NOTICES.md, and THIRD_PARTY_LICENSES.md`);
  }
  if (!thirdPartyNotices.trim() || !thirdPartyLicenses.trim()) {
    throw new Error("third-party notice and full-license records must not be empty");
  }

  console.log(`Release versions are synchronized at ${currentVersion}; license metadata and macOS minimum are present.`);
}

function releaseCheck(tag, version) {
  if (parseSemver(version)?.prerelease) throw new Error(`${version} is a prerelease; releases are published as stable versions only`);
  if (tag !== `v${version}`) throw new Error(`the release tag must be v${version} to match the workspace version`);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const tagCommit = execFileSync("git", ["rev-parse", `refs/tags/${tag}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (head !== tagCommit) throw new Error(`${tag} must point to the checked out commit`);
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  if (status) throw new Error("release source checkout must be clean");
  execFileSync(process.execPath, [resolve(root, "scripts/verify-release-notices.mjs")], { cwd: root, stdio: "inherit" });
  console.log(`${tag} points to the clean checked out commit.`);
}

const [command, value] = process.argv.slice(2);
try {
  if (command === "sync") {
    if (!value) throw new Error("usage: release-version.mjs sync <version>");
    await sync(value);
  } else if (command === "check") {
    await check(value);
  } else if (command === "release-check") {
    if (!value) throw new Error("usage: release-version.mjs release-check <tag>");
    const { version } = await readJson(paths.rootPackage);
    await check(version);
    releaseCheck(value, version);
  } else {
    throw new Error("usage: release-version.mjs <sync <version>|check [expected-version]|release-check <tag>");
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
