import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

// Raised from 180,000 / 225,000 for workspaces, project replace, the Git stash
// tab, the Dock/Jump List recents and interface translations; language files
// load on demand and do not count. The static budget was raised again from
// 245,000 for the editing aids, Explorer menu additions and .env table glue.
// Keep new startup code minimal.
export const ENTRY_BUDGET_BYTES = 186_000;
export const STATIC_BUDGET_BYTES = 250_000;

export async function measureStartupBundle(distDir) {
  const manifest = JSON.parse(await readFile(join(distDir, ".vite", "manifest.json"), "utf8"));
  const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry && manifest[key].src === "index.html");
  if (!entryKey) throw new Error("No index.html entry in the Vite manifest.");
  const visited = new Set();
  const files = new Map();
  const visit = async (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`Missing static dependency in manifest: ${key}`);
    const file = resolve(distDir, chunk.file);
    const local = relative(resolve(distDir), file);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`Chunk is outside the dist directory: ${chunk.file}`);
    }
    if (!files.has(file)) files.set(file, { file: chunk.file, bytes: (await stat(file)).size });
    for (const dependency of chunk.imports ?? []) await visit(dependency);
  };
  await visit(entryKey);
  return {
    entry: manifest[entryKey].file,
    entryBytes: (await stat(join(distDir, manifest[entryKey].file))).size,
    staticBytes: [...files.values()].reduce((sum, file) => sum + file.bytes, 0),
    files: [...files.values()],
  };
}

export function budgetFailures(result) {
  const failures = [];
  if (result.entryBytes > ENTRY_BUDGET_BYTES) failures.push(`Entry ${result.entryBytes} > ${ENTRY_BUDGET_BYTES} bytes`);
  if (result.staticBytes > STATIC_BUDGET_BYTES) failures.push(`Static imports ${result.staticBytes} > ${STATIC_BUDGET_BYTES} bytes`);
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const defaultDist = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/desktop/dist");
    const result = await measureStartupBundle(process.argv[2] ?? defaultDist);
    const failures = budgetFailures(result);
    console.log(JSON.stringify({ ...result, budgets: { entryBytes: ENTRY_BUDGET_BYTES, staticBytes: STATIC_BUDGET_BYTES }, failures }, null, 2));
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
