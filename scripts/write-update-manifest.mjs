import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSemver } from "./semver.mjs";

const [releaseDirectoryArgument, tag, notesFileArgument] = process.argv.slice(2);
const version = tag?.startsWith("v") ? parseSemver(tag.slice(1)) : undefined;
if (!releaseDirectoryArgument || !version || !notesFileArgument) {
  throw new Error("usage: write-update-manifest.mjs <release-directory> <vX.Y.Z> <notes-file>");
}
if (version.prerelease) throw new Error(`${tag} is a prerelease; update manifests are written for stable releases only`);

const releaseDirectory = resolve(releaseDirectoryArgument);
const downloadBase = `https://github.com/MajajaX/pude/releases/download/${encodeURIComponent(tag)}`;
const updatePackages = {
  "darwin-aarch64": "pude-macos-arm64.app.tar.gz",
  "windows-x86_64": "pude-windows-x64-setup.exe",
};

const platforms = {};
for (const [target, packageName] of Object.entries(updatePackages)) {
  let signature;
  try {
    signature = (await readFile(join(releaseDirectory, `${packageName}.sig`), "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  if (!signature) throw new Error(`${packageName}.sig is empty`);
  platforms[target] = { signature, url: `${downloadBase}/${packageName}` };
}
if (Object.keys(platforms).length === 0) throw new Error("no update package signatures found in the release directory");

const manifest = {
  version: tag.slice(1),
  notes: (await readFile(resolve(notesFileArgument), "utf8")).trim(),
  pub_date: new Date().toISOString(),
  platforms,
};
await writeFile(join(releaseDirectory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(`Wrote latest.json for ${tag} covering ${Object.keys(platforms).join(", ")}.`);
