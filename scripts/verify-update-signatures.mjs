import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signedVersionOf, verifyUpdateSignature } from "./minisign.mjs";
import { updatePackages } from "./update-packages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "usage: verify-update-signatures.mjs <release-directory> [--allow-partial] [--config <tauri.conf.json>]";

function parseArguments(argumentsList) {
  const [releaseDirectory, ...options] = argumentsList;
  let allowPartial = false;
  let configPath = join(root, "apps/desktop/src-tauri/tauri.conf.json");
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === "--allow-partial") allowPartial = true;
    else if (options[index] === "--config" && options[index + 1]) configPath = resolve(options[++index]);
    else throw new Error(usage);
  }
  if (!releaseDirectory) throw new Error(usage);
  return { releaseDirectory: resolve(releaseDirectory), allowPartial, configPath };
}

async function verifyReleaseSignatures({ releaseDirectory, allowPartial, configPath }) {
  const publicKeyBase64 = JSON.parse(await readFile(configPath, "utf8")).plugins?.updater?.pubkey;
  if (!publicKeyBase64) throw new Error(`${configPath} has no plugins.updater.pubkey`);
  const manifest = JSON.parse(await readFile(join(releaseDirectory, "latest.json"), "utf8"));
  const verified = [];

  for (const [target, packageName] of Object.entries(updatePackages)) {
    const entry = manifest.platforms?.[target];
    if (!entry) {
      if (allowPartial) continue;
      throw new Error(`latest.json has no ${target} entry`);
    }
    if (basename(new URL(entry.url).pathname) !== packageName) throw new Error(`latest.json ${target} url must end in ${packageName}`);
    const signatureFile = (await readFile(join(releaseDirectory, `${packageName}.sig`), "utf8")).trim();
    if (entry.signature !== signatureFile) throw new Error(`latest.json ${target} signature differs from ${packageName}.sig`);
    try {
      const trustedComment = verifyUpdateSignature({
        publicKeyBase64,
        signatureBase64: entry.signature,
        fileBytes: await readFile(join(releaseDirectory, packageName)),
      });
      const signedVersion = signedVersionOf(trustedComment);
      if (signedVersion !== manifest.version) {
        throw new Error(`signed version ${signedVersion ?? "(none)"} does not match latest.json version ${manifest.version}`);
      }
    } catch (error) {
      throw new Error(`${packageName}: ${error instanceof Error ? error.message : String(error)}`);
    }
    verified.push(target);
  }
  if (verified.length === 0) throw new Error("latest.json lists no update platforms");
  console.log(`Verified updater signatures for ${verified.join(", ")} against plugins.updater.pubkey.`);
}

try {
  await verifyReleaseSignatures(parseArguments(process.argv.slice(2)));
} catch (error) {
  console.error(`verify-update-signatures: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
