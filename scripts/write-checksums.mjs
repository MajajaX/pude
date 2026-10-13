import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, manifestArgument, ...fileArguments] = process.argv.slice(2);

async function sha256(path) {
  const fileInfo = await stat(path);
  if (!fileInfo.isFile() || fileInfo.size === 0) throw new Error(`artifact is missing or empty: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function create() {
  if (!manifestArgument || fileArguments.length === 0) {
    throw new Error("usage: write-checksums.mjs create <manifest> <artifact> [...]");
  }
  const files = await Promise.all(fileArguments.map(async (argument) => {
    const path = resolve(argument);
    return { path, name: basename(path), hash: await sha256(path) };
  }));
  if (new Set(files.map((file) => file.name)).size !== files.length) {
    throw new Error("artifact basenames must be unique");
  }
  files.sort((left, right) => left.name.localeCompare(right.name));
  const manifestPath = resolve(manifestArgument);
  const contents = `${files.map(({ hash, name }) => `${hash}  ${name}`).join("\n")}\n`;
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, contents, { flag: "wx" });
  await verify(manifestPath, dirname(manifestPath));
  console.log(`Wrote and verified ${files.length} SHA-256 entries in ${manifestPath}.`);
}

async function verify(manifestPathArgument, artifactDirectoryArgument) {
  if (!manifestPathArgument) throw new Error("usage: write-checksums.mjs verify <manifest> [artifact-directory]");
  const manifestPath = resolve(manifestPathArgument);
  const artifactDirectory = resolve(artifactDirectoryArgument ?? dirname(manifestPath));
  const lines = (await readFile(manifestPath, "utf8")).trimEnd().split(/\r?\n/);
  if (lines.length === 0 || lines.some((line) => !/^[0-9a-f]{64}  [A-Za-z0-9._-]+$/.test(line))) {
    throw new Error(`invalid SHA-256 manifest: ${manifestPath}`);
  }
  const names = new Set();
  for (const line of lines) {
    const [expected, name] = line.split("  ");
    if (names.has(name)) throw new Error(`duplicate checksum entry: ${name}`);
    names.add(name);
    const actual = await sha256(join(artifactDirectory, name));
    if (actual !== expected) throw new Error(`SHA-256 mismatch for ${name}`);
  }
  console.log(`Verified ${lines.length} SHA-256 entries from ${manifestPath}.`);
}

try {
  if (command === "create") await create();
  else if (command === "verify") await verify(manifestArgument, fileArguments[0]);
  else throw new Error("usage: write-checksums.mjs <create|verify> ...");
} catch (error) {
  console.error(`write-checksums: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
