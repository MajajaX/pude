// Checks that THIRD_PARTY_NOTICES.md lists every direct npm and Cargo dependency at
// the version the lockfiles resolve, so a dependency update cannot leave the
// notices describing an older release.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(resolve(root, path), "utf8");

/** `| \`name\` | version | …` rows of the notice tables. */
function listedVersions(notices) {
  const listed = new Map();
  for (const [, name, version] of notices.matchAll(/^\| `([^`]+)` \| ([^ |]+) \|/gm)) listed.set(name, version);
  return listed;
}

async function npmDependencies() {
  const lock = JSON.parse(await read("package-lock.json"));
  const dependencies = new Map();
  for (const manifestPath of ["package.json", "apps/desktop/package.json", "apps/web/package.json"]) {
    const manifest = JSON.parse(await read(manifestPath));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      dependencies.set(name, lock.packages[`node_modules/${name}`]?.version);
    }
  }
  return dependencies;
}

/** Direct crates outside [dev-dependencies], which only add test features. */
async function cargoDependencies() {
  const manifest = await read("apps/desktop/src-tauri/Cargo.toml");
  const lock = (await read("apps/desktop/src-tauri/Cargo.lock")).replace(/\r\n/g, "\n");
  const dependencies = new Map();
  let section = "";
  for (const line of manifest.split(/\r?\n/)) {
    const header = line.match(/^\[(.+)\]$/);
    if (header) section = header[1];
    const dependency = line.match(/^([A-Za-z0-9_-]+) = (?:\{ version = )?"=([^"]+)"/);
    if (dependency && /dependencies$/.test(section) && section !== "dev-dependencies") {
      const [, name, version] = dependency;
      const locked = lock.includes(`[[package]]\nname = "${name}"\nversion = "${version}"`);
      dependencies.set(name, locked ? version : undefined);
    }
  }
  return dependencies;
}

const listed = listedVersions(await read("THIRD_PARTY_NOTICES.md"));
const problems = [];
for (const [name, version] of [...(await npmDependencies()), ...(await cargoDependencies())]) {
  if (!version) problems.push(`${name}: not resolved in the lockfile`);
  else if (!listed.has(name)) problems.push(`${name} ${version}: missing from THIRD_PARTY_NOTICES.md`);
  else if (listed.get(name) !== version)
    problems.push(`${name}: THIRD_PARTY_NOTICES.md lists ${listed.get(name)}, the lockfile resolves ${version}`);
}

if (problems.length) {
  console.error("THIRD_PARTY_NOTICES.md is out of date with the direct dependencies:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("THIRD_PARTY_NOTICES.md lists every direct dependency at its locked version.");
