import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSemver } from "../shared/semver.mjs";
import { updatePackages } from "./update-packages.mjs";

const [releaseDirectoryArgument, tag, notesFileArgument, ...options] = process.argv.slice(2);
const version = tag?.startsWith("v") ? parseSemver(tag.slice(1)) : undefined;
const allowPartial = options.length === 1 && options[0] === "--allow-partial";
if (!releaseDirectoryArgument || !version || !notesFileArgument || (options.length > 0 && !allowPartial)) {
  throw new Error("usage: write-update-manifest.mjs <release-directory> <vX.Y.Z> <notes-file> [--allow-partial]");
}
if (version.prerelease) throw new Error(`${tag} is a prerelease; update manifests are written for stable releases only`);

const releaseDirectory = resolve(releaseDirectoryArgument);
const downloadBase = `https://github.com/MajajaX/pude/releases/download/${encodeURIComponent(tag)}`;

const platforms = {};
for (const [target, packageName] of Object.entries(updatePackages)) {
  let signature;
  try {
    signature = (await readFile(join(releaseDirectory, `${packageName}.sig`), "utf8")).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (allowPartial) continue;
    throw new Error(`${packageName}.sig is missing; pass --allow-partial to publish a single-platform manifest`);
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
